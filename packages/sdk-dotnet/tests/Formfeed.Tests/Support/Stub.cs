using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Formfeed.Tests.Support;

/// <summary>Where the package folder and the repository are, so the tests read the shared fixtures.</summary>
internal static class Paths
{
    public static string Package { get; } = typeof(Paths).Assembly
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .Single(attribute => attribute.Key == "FormfeedPackageRoot")
        .Value!;

    /// <summary>The repository the package lies in: <c>packages/sdk-dotnet</c> two folders down.</summary>
    public static string Repository { get; } = Path.GetFullPath(Path.Combine(Package, "..", ".."));

    public static string Vectors { get; } = Path.Combine(Repository, "packages", "api-types", "fixtures", "sdk");

    public static string Goldens { get; } = Path.Combine(Repository, "packages", "api-types", "fixtures", "contract");
}

/// <summary>A request as the stub received it, its body read before the client disposed it.</summary>
public sealed class Recorded
{
    private readonly Dictionary<string, string> headers;

    internal Recorded(HttpRequestMessage request, byte[] body)
    {
        Method = request.Method.Method;
        Uri = request.RequestUri!.OriginalString;
        Body = body;
        headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var header in request.Headers)
        {
            headers[header.Key] = string.Join(", ", header.Value);
        }
        if (request.Content is not null)
        {
            foreach (var header in request.Content.Headers)
            {
                headers[header.Key] = string.Join(", ", header.Value);
            }
        }
    }

    public string Method { get; }

    public string Uri { get; }

    public byte[] Body { get; }

    public string Text => Encoding.UTF8.GetString(Body);

    public string? Header(string name) => headers.TryGetValue(name, out var value) ? value : null;

    public bool HasHeader(string name) => headers.ContainsKey(name);
}

/// <summary>An <see cref="HttpMessageHandler"/> that answers from a function and keeps every request it was sent.</summary>
public sealed class StubHandler(Func<Recorded, int, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
{
    private readonly List<Recorded> requests = [];

    public IReadOnlyList<Recorded> Requests => requests;

    public Recorded this[int index] => requests[index];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        var recorded = new Recorded(request, body);
        requests.Add(recorded);
        var response = await respond(recorded, requests.Count, cancellationToken);
        response.RequestMessage ??= request;
        return response;
    }
}

internal static class Answers
{
    public static HttpResponseMessage Json(string json, int status = 200, params (string Name, string Value)[] headers)
    {
        var response = new HttpResponseMessage((HttpStatusCode)status)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        foreach (var (name, value) in headers)
        {
            response.Headers.TryAddWithoutValidation(name, value);
        }
        return response;
    }

    public static HttpResponseMessage Bytes(byte[] bytes, string contentType, int status = 200)
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.TryAddWithoutValidation("Content-Type", contentType);
        return new HttpResponseMessage((HttpStatusCode)status) { Content = content };
    }

    public static HttpResponseMessage Empty(int status) => new((HttpStatusCode)status);
}
