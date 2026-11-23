using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Formfeed.Tests.Support;

public abstract class ClientTestBase
{
    /// <summary>A finished render as the API answers it.</summary>
    protected const string RenderJson = """
        {
          "id": "rnd_1",
          "status": "succeeded",
          "output": "pdf",
          "download_url": "https://cdn.formfeed.test/o/x.pdf?exp=1&sig=2",
          "expires_at": "2026-12-18T10:00:00Z",
          "bytes": 5681,
          "page_count": 1,
          "units": 1,
          "region": "eu",
          "environment": "test",
          "template": { "id": "tpl_1", "slug": "invoice", "version": 3 },
          "meta": {},
          "created_at": "2026-11-18T10:00:00Z",
          "completed_at": "2026-11-18T10:00:01Z"
        }
        """;

    protected const string DownloadUrl = "https://cdn.formfeed.test/o/x.pdf?exp=1&sig=2";

    /// <summary>The seconds the client waited, in order.</summary>
    protected List<double> Waits { get; } = [];

    /// <summary>A client that sends to a stub and records its waits instead of sleeping.</summary>
    protected (FormfeedClient Client, StubHandler Http) Client(
        Func<Recorded, int, HttpResponseMessage> respond,
        int maxRetries = 3,
        string region = "eu",
        Uri? baseUrl = null,
        double jitter = 0.5) =>
        Client((request, n, _) => Task.FromResult(respond(request, n)), maxRetries, region, baseUrl, jitter);

    /// <summary>A client whose stub answers when it likes, for time limits and cancellation.</summary>
    protected (FormfeedClient Client, StubHandler Http) Client(
        Func<Recorded, int, CancellationToken, Task<HttpResponseMessage>> respond,
        int maxRetries = 3,
        string region = "eu",
        Uri? baseUrl = null,
        double jitter = 0.5,
        TimeSpan? timeout = null)
    {
        var http = new StubHandler(respond);
        Waits.Clear();
        var options = new FormfeedClientOptions
        {
            ApiKey = "ff_test_k",
            Region = region,
            BaseUrl = baseUrl,
            MaxRetries = maxRetries,
            Delay = (time, _) =>
            {
                Waits.Add(time.TotalSeconds);
                return Task.CompletedTask;
            },
            Jitter = () => jitter,
        };
        if (timeout is { } limit)
        {
            options.Timeout = limit;
        }
        return (new FormfeedClient(options, new HttpClient(http)), http);
    }

    /// <summary>The render with another id and status.</summary>
    protected static string RenderWith(string id, string? status = null)
    {
        var render = System.Text.Json.Nodes.JsonNode.Parse(RenderJson)!.AsObject();
        render["id"] = id;
        if (status is not null)
        {
            render["status"] = status;
        }
        return render.ToJsonString();
    }

    protected static Render ARender() => Render.FromJson(RenderJson);

    protected static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    /// <summary>The fields of a multipart request in their order, the file as filename, content type and bytes.</summary>
    protected static List<(string Name, string? FileName, string? ContentType, string Value)> Parts(Recorded request)
    {
        var contentType = request.Header("Content-Type") ?? "";
        Assert.StartsWith("multipart/form-data; boundary=", contentType, StringComparison.Ordinal);
        var boundary = contentType["multipart/form-data; boundary=".Length..];
        var body = Encoding.UTF8.GetString(request.Body);
        Assert.EndsWith($"--{boundary}--\r\n", body, StringComparison.Ordinal);
        var parts = new List<(string, string?, string?, string)>();
        foreach (var chunk in body.Split($"--{boundary}"))
        {
            var split = chunk.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (split < 0)
            {
                continue;
            }
            var head = chunk[..split].TrimStart('\r', '\n');
            var content = chunk[(split + 4)..^2];
            var name = Regex.Match(head, "name=\"([^\"]*)\"").Groups[1].Value;
            var file = Regex.Match(head, "filename=\"([^\"]*)\"");
            var type = Regex.Match(head, "Content-Type: (.*)");
            parts.Add((
                name,
                file.Success ? file.Groups[1].Value : null,
                type.Success ? type.Groups[1].Value.Trim() : null,
                content));
        }
        return parts;
    }
}
