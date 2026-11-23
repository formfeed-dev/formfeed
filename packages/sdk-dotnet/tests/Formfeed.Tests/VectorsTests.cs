using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Formfeed.Tests.Support;
using Xunit;

namespace Formfeed.Tests;

/// <summary>
/// The test vectors every Formfeed SDK reads (plan 34, decision 9), written by
/// <c>packages/api-types/src/lib/sdk-fixtures.spec.ts</c>: webhook signatures, retries and problems,
/// played through the client as a caller meets them.
/// </summary>
public sealed class VectorsTests : ClientTestBase
{
    private static JsonElement Vectors(string name)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(Paths.Vectors, name + ".json")));
        return document.RootElement.Clone();
    }

    private static JsonElement Case(string file, string name)
    {
        foreach (var item in Vectors(file).GetProperty("cases").EnumerateArray())
        {
            if (item.GetProperty("name").GetString() == name)
            {
                return item;
            }
        }
        throw new InvalidOperationException($"{file}.json has no case {name}");
    }

    private static TheoryData<string> Names(string file)
    {
        var data = new TheoryData<string>();
        foreach (var item in Vectors(file).GetProperty("cases").EnumerateArray())
        {
            data.Add(item.GetProperty("name").GetString()!);
        }
        return data;
    }

    public static TheoryData<string> WebhookCases() => Names("webhook-signatures");

    public static TheoryData<string> ProblemCases() => Names("problems");

    /// <summary>Every retry case at the lowest and at the highest jitter.</summary>
    public static TheoryData<string, double> RetryCases()
    {
        var data = new TheoryData<string, double>();
        foreach (var item in Vectors("retries").GetProperty("cases").EnumerateArray())
        {
            data.Add(item.GetProperty("name").GetString()!, 0.0);
            data.Add(item.GetProperty("name").GetString()!, 1.0);
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(WebhookCases))]
    public void Webhook_signature(string name)
    {
        var vectors = Vectors("webhook-signatures");
        var item = Case("webhook-signatures", name);
        var header = item.GetProperty("header");
        var body = item.GetProperty("body");
        var raw = body.ValueKind == JsonValueKind.String ? body.GetString()! : vectors.GetProperty("body").GetString()!;
        var tolerance = TimeSpan.FromSeconds(vectors.GetProperty("tolerance_seconds").GetInt32());
        var now = DateTimeOffset.FromUnixTimeSeconds(vectors.GetProperty("now").GetInt64());
        var secret = vectors.GetProperty("secret").GetString()!;
        var signature = header.ValueKind == JsonValueKind.String ? header.GetString() : null;
        var valid = item.GetProperty("valid").GetBoolean();

        Assert.Equal(valid, Webhook.Verify(secret, signature, raw, tolerance, now));
        Assert.Equal(valid, Webhook.Verify(secret, signature, Encoding.UTF8.GetBytes(raw), tolerance, now));
    }

    [Theory]
    [MemberData(nameof(RetryCases))]
    public async Task Retries(string name, double jitter)
    {
        var item = Case("retries", name);
        var answers = item.GetProperty("answers");
        var maxRetries = Vectors("retries").GetProperty("max_retries").GetInt32();
        var (client, http) = Client(
            (_, n) =>
            {
                var answer = answers[n - 1];
                if (answer.TryGetProperty("network_error", out var failed) && failed.GetBoolean())
                {
                    throw new HttpRequestException("connection refused");
                }
                var status = answer.TryGetProperty("status", out var code) ? code.GetInt32() : 200;
                var body = answer.TryGetProperty("body", out var json) ? json.GetRawText() : "{}";
                return answer.TryGetProperty("retry_after", out var after)
                    ? Answers.Json(body, status, ("Retry-After", after.GetString()!))
                    : Answers.Json(body, status);
            },
            maxRetries,
            jitter: jitter);

        FormfeedException? error = null;
        try
        {
            await client.RequestAsync(HttpMethod.Get, "/account");
        }
        catch (FormfeedException e)
        {
            error = e;
        }

        var outcome = item.GetProperty("outcome");
        if (outcome.TryGetProperty("error", out var expected))
        {
            Assert.NotNull(error);
            Assert.Equal(expected.GetProperty("code").GetString(), error.Code);
            Assert.Equal(expected.GetProperty("status").GetInt32(), error.Status);
        }
        else
        {
            Assert.True(outcome.GetProperty("ok").GetBoolean());
            Assert.Null(error);
        }
        Assert.Equal(answers.GetArrayLength(), http.Requests.Count);
        var bounds = item.GetProperty("waits_ms");
        Assert.Equal(bounds.GetArrayLength(), Waits.Count);
        for (var n = 0; n < Waits.Count; n++)
        {
            var lowest = bounds[n][0].GetDouble();
            var highest = bounds[n][1].GetDouble();
            var waited = Math.Round(Waits[n] * 1000, 6);
            Assert.InRange(waited, lowest, highest);
            // the jitter's ends are the bounds' ends
            Assert.Equal(jitter == 0 ? lowest : highest, waited);
        }
    }

    [Theory]
    [MemberData(nameof(ProblemCases))]
    public async Task Problem(string name)
    {
        var item = Case("problems", name);
        var status = item.GetProperty("status").GetInt32();
        var body = item.GetProperty("body");
        var (client, _) = Client(
            (_, _) =>
            {
                var response = body.ValueKind switch
                {
                    JsonValueKind.Null => Answers.Empty(status),
                    JsonValueKind.String => new HttpResponseMessage((System.Net.HttpStatusCode)status)
                    {
                        Content = new StringContent(body.GetString()!, Encoding.UTF8, "text/plain"),
                    },
                    _ => Answers.Json(body.GetRawText(), status),
                };
                foreach (var header in item.GetProperty("headers").EnumerateObject())
                {
                    response.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
                }
                return response;
            },
            maxRetries: 0);

        var error = await Assert.ThrowsAsync<FormfeedException>(() => client.RequestAsync(HttpMethod.Get, "/account"));

        var expect = item.GetProperty("expect");
        Assert.Equal(expect.GetProperty("code").GetString(), error.Code);
        Assert.Equal(expect.GetProperty("message").GetString(), error.Message);
        Assert.Equal(expect.GetProperty("status").GetInt32(), error.Status);
        var requestId = expect.GetProperty("request_id");
        Assert.Equal(requestId.ValueKind == JsonValueKind.Null ? null : requestId.GetString(), error.RequestId);
    }
}
