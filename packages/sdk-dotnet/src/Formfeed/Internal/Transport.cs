using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Formfeed.Internal;

/// <summary>
/// Auth, retries and problems, the rules every Formfeed SDK keeps (plan 34, decision 3): up to
/// <c>MaxRetries</c> retries on 429, 503 and network errors, waiting a positive numeric
/// <c>Retry-After</c> in seconds, else 0.5 s doubling, plus up to 0.25 s of jitter, at most 30 s; a
/// problem becomes one <see cref="FormfeedException"/> with the code, the detail (else the title),
/// the status and <c>X-Request-Id</c>. <c>packages/api-types/fixtures/sdk</c> holds the cases, which
/// every SDK's tests play.
/// </summary>
internal sealed class Transport : IDisposable
{
    public const string UserAgent = "formfeed-sdk-dotnet/0.3";

    private static readonly Random Random = new();

    private readonly HttpClient http;
    private readonly bool ownsHttp;
    private readonly string apiKey;
    private readonly string baseUrl;
    private readonly int maxRetries;
    private readonly TimeSpan timeout;
    private readonly KeyValuePair<string, string>[] headers;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly Func<double> jitter;

    public Transport(FormfeedClientOptions options, string baseUrl, HttpClient? http)
    {
        apiKey = options.ApiKey;
        this.baseUrl = baseUrl;
        maxRetries = Math.Max(0, options.MaxRetries);
        timeout = options.Timeout > TimeSpan.Zero ? options.Timeout : TimeSpan.FromSeconds(120);
        headers = options.Headers.ToArray();
        delay = options.Delay ?? Task.Delay;
        jitter = options.Jitter ?? NextJitter;
        Serializer = options.JsonSerializerOptions;
        ownsHttp = http is null;
        this.http = http ?? CreateHttpClient();
    }

    /// <summary>How free values that are objects of the caller's own are written.</summary>
    public JsonSerializerOptions? Serializer { get; }

    /// <summary>The decoded JSON answer, null for one without a body (204).</summary>
    public async Task<JsonElement?> JsonAsync(
        HttpMethod method,
        string path,
        object? body,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var (status, bytes) = await SendAsync(method, path, body, idempotencyKey, cancellationToken).ConfigureAwait(false);
        if (status == 204 || bytes.Length == 0)
        {
            return null;
        }
        try
        {
            return ModelReader.Parse(bytes);
        }
        catch (JsonException e)
        {
            throw new FormfeedException(
                "invalid_response",
                $"the API answered HTTP {status} with a body that is not JSON",
                status,
                null,
                null,
                e);
        }
    }

    /// <summary>An answer that is a JSON object.</summary>
    public async Task<JsonElement> ObjectAsync(
        HttpMethod method,
        string path,
        object? body,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var value = await JsonAsync(method, path, body, idempotencyKey, cancellationToken).ConfigureAwait(false);
        if (value is not { ValueKind: JsonValueKind.Object } json)
        {
            throw new FormfeedException("invalid_response", $"the API answered {method} {path} without a JSON object");
        }
        return json;
    }

    /// <summary>A multipart body of the fields and the file, written the way the API reads it.</summary>
    public Multipart Multipart(FieldList fields, Upload? file) => new(fields, file, Serializer);

    /// <summary>Waits, the way the client was told to.</summary>
    public Task WaitAsync(TimeSpan time, CancellationToken cancellationToken) => delay(time, cancellationToken);

    /// <summary>
    /// A signed link of the CDN, without the API key, which the link does not need, and without
    /// retries, as every Formfeed SDK downloads.
    /// </summary>
    public async Task<long> DownloadAsync(string url, Stream destination, CancellationToken cancellationToken)
    {
        using var attempt = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        attempt.CancelAfter(timeout);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            using var response = await http
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, attempt.Token)
                .ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (status >= 400)
            {
                throw new FormfeedException("download_failed", $"download answered HTTP {status}", status);
            }
            if (response.Content is null)
            {
                return 0;
            }
#if NET
            using var source = await response.Content.ReadAsStreamAsync(attempt.Token).ConfigureAwait(false);
#else
            using var source = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
#endif
            var counting = new CountingStream(destination);
            await source.CopyToAsync(counting, 81920, attempt.Token).ConfigureAwait(false);
            return counting.Written;
        }
        catch (Exception e) when (IsNetworkFailure(e, cancellationToken))
        {
            throw new FormfeedException("network_error", MessageOf(e), 0, null, null, e);
        }
    }

    /// <summary>The seconds to wait before retry number <paramref name="attempt"/> (from 1), with the server's Retry-After.</summary>
    public static double Backoff(int attempt, string? retryAfter, double jitter)
    {
        var seconds = 0.5 * Math.Pow(2, attempt - 1);
        var header = retryAfter?.Trim();
        if (!string.IsNullOrEmpty(header)
            && double.TryParse(header, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            && value > 0
            && !double.IsInfinity(value)
            && !double.IsNaN(value))
        {
            seconds = value;
        }
        return Math.Min(30.0, seconds + (Math.Min(1.0, Math.Max(0.0, jitter)) * 0.25));
    }

    public void Dispose()
    {
        if (ownsHttp)
        {
            http.Dispose();
        }
    }

    private async Task<(int Status, byte[] Body)> SendAsync(
        HttpMethod method,
        string path,
        object? body,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        byte[]? payload = null;
        string? contentType = null;
        if (body is Multipart multipart)
        {
            payload = multipart.Body();
            contentType = multipart.ContentType;
        }
        else if (body is not null)
        {
            payload = JsonWire.Encode(body, Serializer);
            contentType = "application/json";
        }

        for (var attempt = 0; ; attempt++)
        {
            using var request = new HttpRequestMessage(method, baseUrl + path);
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + apiKey);
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            foreach (var header in headers)
            {
                request.Headers.Remove(header.Key);
                request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            if (idempotencyKey is not null)
            {
                request.Headers.Remove("Idempotency-Key");
                request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
            }
            // fresh content for every attempt, so a retry sends the same bytes again
            if (payload is not null)
            {
                request.Content = new ByteArrayContent(payload);
                request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType!);
            }

            int status;
            byte[] bytes;
            string? retryAfter;
            string? requestId;
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            limit.CancelAfter(timeout);
            try
            {
                using var response = await http
                    .SendAsync(request, HttpCompletionOption.ResponseContentRead, limit.Token)
                    .ConfigureAwait(false);
                status = (int)response.StatusCode;
#if NET
                bytes = await response.Content.ReadAsByteArrayAsync(limit.Token).ConfigureAwait(false);
#else
                bytes = response.Content is null
                    ? []
                    : await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
#endif
                retryAfter = Header(response, "Retry-After");
                requestId = Header(response, "X-Request-Id");
            }
            catch (Exception e) when (IsNetworkFailure(e, cancellationToken))
            {
                if (attempt < maxRetries)
                {
                    await WaitAsync(TimeSpan.FromSeconds(Backoff(attempt + 1, null, jitter())), cancellationToken)
                        .ConfigureAwait(false);
                    continue;
                }
                throw new FormfeedException(
                    "network_error",
                    e is OperationCanceledException ? $"the request timed out after {timeout.TotalSeconds:0.###} s" : MessageOf(e),
                    0,
                    null,
                    null,
                    e);
            }

            if ((status is 429 or 503) && attempt < maxRetries)
            {
                await WaitAsync(TimeSpan.FromSeconds(Backoff(attempt + 1, retryAfter, jitter())), cancellationToken)
                    .ConfigureAwait(false);
                continue;
            }
            if (status >= 400)
            {
                throw ProblemOf(status, bytes, requestId);
            }
            return (status, bytes);
        }
    }

    private static FormfeedException ProblemOf(int status, byte[] body, string? requestId)
    {
        JsonElement? json = null;
        if (body.Length > 0)
        {
            try
            {
                json = ModelReader.Parse(body);
            }
            catch (JsonException)
            {
                // a body that is not JSON, such as a proxy's page: the status speaks for it
            }
        }
        var problem = json is { ValueKind: JsonValueKind.Object } document && document.EnumerateObject().Any()
            ? Problem.FromJson(document)
            : null;
        var code = problem is null ? null : ModelReader.String(problem.Raw, "code");
        var detail = problem is null ? null : ModelReader.String(problem.Raw, "detail");
        var title = problem is null ? null : ModelReader.String(problem.Raw, "title");
        return new FormfeedException(
            string.IsNullOrEmpty(code) ? $"http_{status}" : code!,
            !string.IsNullOrEmpty(detail) ? detail! : !string.IsNullOrEmpty(title) ? title! : $"HTTP {status}",
            status,
            problem,
            string.IsNullOrEmpty(requestId) ? null : requestId);
    }

    private static string? Header(HttpResponseMessage response, string name)
    {
#if NET
        if (response.Headers.NonValidated.TryGetValues(name, out var values))
        {
            return string.Join(", ", values);
        }
        return null;
#else
        return response.Headers.TryGetValues(name, out var values) ? string.Join(", ", values) : null;
#endif
    }

    /// <summary>A failure to reach the API or to hear its answer, which a retry may cure; never the caller's own cancellation.</summary>
    private static bool IsNetworkFailure(Exception e, CancellationToken cancellationToken) =>
        e is HttpRequestException or IOException
        || (e is OperationCanceledException && !cancellationToken.IsCancellationRequested);

    private static string MessageOf(Exception e) =>
        e is OperationCanceledException ? "the request timed out" : e.Message;

    private static double NextJitter()
    {
        lock (Random)
        {
            return Random.NextDouble();
        }
    }

    private static HttpClient CreateHttpClient()
    {
#if NET
        var handler = new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) };
#else
        var handler = new HttpClientHandler();
#endif
        // the SDK's own limit applies per attempt (Timeout), so the client's stays out of the way
        return new HttpClient(handler, disposeHandler: true) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
    }

    /// <summary>Counts what passes through to the destination.</summary>
    private sealed class CountingStream(Stream inner) : Stream
    {
        public long Written { get; private set; }

        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() => inner.Flush();

        public override Task FlushAsync(CancellationToken cancellationToken) => inner.FlushAsync(cancellationToken);

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
        {
            inner.Write(buffer, offset, count);
            Written += count;
        }

        public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
#if NET
            await inner.WriteAsync(buffer.AsMemory(offset, count), cancellationToken).ConfigureAwait(false);
#else
            await inner.WriteAsync(buffer, offset, count, cancellationToken).ConfigureAwait(false);
#endif
            Written += count;
        }

#if NET
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await inner.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
            Written += buffer.Length;
        }
#endif
    }
}
