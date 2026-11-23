using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Formfeed.Tests.Support;
using Xunit;

namespace Formfeed.Tests;

public sealed class ClientTests : ClientTestBase
{
    private const string Uuid = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

    [Fact]
    public async Task A_render_sends_the_key_an_idempotency_key_and_json()
    {
        var (client, http) = Client((_, _) => Answers.Json(RenderJson, 201));

        var render = await client.Renders.CreateAsync(new RenderRequest
        {
            Template = "invoice",
            Data = new Dictionary<string, object?> { ["a"] = 1 },
            Output = "pdf",
        });

        Assert.Equal("rnd_1", render.Id);
        Assert.True(render.IsFinished);
        Assert.Equal(1, render.PageCount);
        Assert.Equal("invoice", render.Template?.Slug);
        Assert.Equal(3, render.Template?.Version);
        Assert.Equal(new DateTimeOffset(2026, 11, 18, 10, 0, 1, TimeSpan.Zero), render.CompletedAt);
        var request = http[0];
        Assert.Equal("POST", request.Method);
        Assert.Equal("https://api-eu.formfeed.dev/v1/renders", request.Uri);
        Assert.Equal("Bearer ff_test_k", request.Header("Authorization"));
        Assert.Equal("formfeed-sdk-dotnet/0.3", request.Header("User-Agent"));
        Assert.Equal("application/json", request.Header("Accept"));
        Assert.Equal("application/json", request.Header("Content-Type"));
        Assert.Matches(Uuid, request.Header("Idempotency-Key"));
        Assert.Equal("""{"template":"invoice","data":{"a":1},"output":"pdf"}""", request.Text);
    }

    [Fact]
    public async Task Empty_data_is_sent_as_an_object()
    {
        var (client, http) = Client((_, _) => Answers.Json(RenderJson, 201));

        await client.Renders.CreateAsync(new RenderRequest { Template = "invoice", Data = new Dictionary<string, object?>() });

        Assert.Equal("""{"template":"invoice","data":{}}""", http[0].Text);
    }

    [Fact]
    public async Task A_given_idempotency_key_is_sent_as_it_is()
    {
        var (client, http) = Client((_, _) => Answers.Json(RenderJson, 201));

        await client.Renders.CreateAsync(new RenderRequest { Html = "<p>x</p>" }, "order-1234");

        Assert.Equal("order-1234", http[0].Header("Idempotency-Key"));
    }

    [Fact]
    public async Task The_region_or_a_base_url_names_the_host()
    {
        var (us, http) = Client((_, _) => Answers.Json(RenderJson), region: "us");
        await us.Renders.GetAsync("rnd_1");
        Assert.Equal("https://api-us.formfeed.dev/v1/renders/rnd_1", http[0].Uri);

        var (local, localHttp) = Client((_, _) => Answers.Json(RenderJson), baseUrl: new Uri("http://localhost:8787/v1/"));
        await local.Renders.GetAsync("rnd_1");
        Assert.Equal("http://localhost:8787/v1/renders/rnd_1", localHttp[0].Uri);
    }

    [Fact]
    public void An_unknown_region_is_refused()
    {
        var error = Assert.Throws<FormfeedException>(() => Client((_, _) => Answers.Json("{}"), region: "ap"));
        Assert.Equal("invalid_request", error.Code);
        Assert.Contains("unknown region", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_key_is_required()
    {
        var error = Assert.Throws<FormfeedException>(() => new FormfeedClient(Environment.GetEnvironmentVariable("FORMFEED_NO_SUCH_KEY")));
        Assert.Equal("invalid_request", error.Code);
    }

    [Fact]
    public async Task A_problem_becomes_one_exception()
    {
        var (client, _) = Client((_, _) => Answers.Json(
            """
            {"type":"https://docs.formfeed.dev/errors/quota-exceeded","title":"Quota exceeded","status":402,
             "detail":"The period has no units left.","code":"quota_exceeded","limit":1000}
            """,
            402,
            ("X-Request-Id", "req_9")));

        var error = await Assert.ThrowsAsync<FormfeedException>(
            () => client.Renders.CreateAsync(new RenderRequest { Template = "invoice" }));

        Assert.Equal("quota_exceeded", error.Code);
        Assert.Equal("The period has no units left.", error.Message);
        Assert.Equal(402, error.Status);
        Assert.Equal("req_9", error.RequestId);
        Assert.Equal("Quota exceeded", error.Problem?.Title);
        Assert.Equal("https://docs.formfeed.dev/errors/quota-exceeded", error.Problem?.Type);
        Assert.Equal(1000, error.Problem?.Raw.GetProperty("limit").GetInt32());
    }

    [Fact]
    public async Task A_retry_sends_the_same_idempotency_key()
    {
        var (client, http) = Client((_, n) => n == 1
            ? Answers.Json("""{"code":"rate_limited"}""", 429, ("Retry-After", "1"))
            : Answers.Json(RenderJson, 201));

        await client.Renders.CreateAsync(new RenderRequest { Template = "invoice" });

        Assert.Equal(2, http.Requests.Count);
        Assert.Equal(http[0].Header("Idempotency-Key"), http[1].Header("Idempotency-Key"));
        Assert.Equal(http[0].Text, http[1].Text);
        var wait = Assert.Single(Waits);
        Assert.InRange(wait, 1.0, 1.25);
    }

    [Fact]
    public async Task Wait_for_polls_until_the_render_is_finished()
    {
        var (client, http) = Client((_, n) => Answers.Json(n < 3 ? """{"id":"rnd_1","status":"processing"}""" : RenderJson));

        var render = await client.Renders.WaitForAsync("rnd_1");

        Assert.Equal("succeeded", render.Status);
        Assert.Equal(3, http.Requests.Count);
        Assert.Equal([1.0, 1.0], Waits);
    }

    [Fact]
    public async Task Wait_for_ends_at_its_timeout()
    {
        var (client, http) = Client((_, _) => Answers.Json("""{"id":"rnd_1","status":"queued"}"""));

        var error = await Assert.ThrowsAsync<FormfeedException>(
            () => client.Renders.WaitForAsync("rnd_1", TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(1)));

        Assert.Equal("timeout", error.Code);
        Assert.Equal([1.0, 1.0, 1.0], Waits);
        Assert.Equal(4, http.Requests.Count);
    }

    [Fact]
    public async Task A_job_is_waited_for_until_no_render_of_it_runs()
    {
        var (client, http) = Client((_, n) => Answers.Json(n < 2
            ? """{"id":"job_1","type":"batch","status":"processing","total":2,"items":[]}"""
            : $$"""{"id":"job_1","type":"batch","status":"partially_failed","total":2,"succeeded":1,"failed":1,"items":[{{RenderJson}},{{RenderWith("rnd_2", "failed")}},7]}"""));

        var job = await client.Jobs.WaitForAsync("job_1");

        Assert.Equal("partially_failed", job.Status);
        Assert.True(job.IsFinished);
        Assert.Equal(["rnd_1", "rnd_2"], job.Items.Select(render => render.Id));
        Assert.Equal("rnd_2", job.Items[1].Raw.GetProperty("id").GetString());
        Assert.Equal([2.0], Waits);
        Assert.Equal("https://api-eu.formfeed.dev/v1/jobs/job_1", http[1].Uri);
    }

    [Fact]
    public async Task A_download_follows_the_signed_link_without_the_key()
    {
        var (client, http) = Client((_, _) => Answers.Bytes(Encoding.ASCII.GetBytes("%PDF-1.7"), "application/pdf"));

        var bytes = await client.Renders.DownloadAsync(ARender());

        Assert.Equal("%PDF-1.7", Encoding.ASCII.GetString(bytes));
        Assert.Equal(DownloadUrl, http[0].Uri);
        Assert.False(http[0].HasHeader("Authorization"));
    }

    [Fact]
    public async Task A_download_goes_to_a_stream_and_to_a_file()
    {
        var (client, _) = Client((_, _) => Answers.Bytes(Encoding.ASCII.GetBytes("%PDF-1.7 bytes"), "application/pdf"));
        using var stream = new MemoryStream();
        var path = Path.Combine(Path.GetTempPath(), $"formfeed-{Guid.NewGuid():N}.pdf");

        try
        {
            Assert.Equal(14, await client.Renders.DownloadToAsync(ARender(), stream));
            Assert.Equal(14, await client.Renders.DownloadToAsync(ARender(), path));
            Assert.Equal("%PDF-1.7 bytes", Encoding.ASCII.GetString(stream.ToArray()));
            Assert.Equal("%PDF-1.7 bytes", File.ReadAllText(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task A_link_that_answers_an_error_is_a_failed_download()
    {
        var (client, http) = Client((_, _) => Answers.Empty(403));

        var error = await Assert.ThrowsAsync<FormfeedException>(() => client.Renders.DownloadAsync(ARender()));

        Assert.Equal("download_failed", error.Code);
        Assert.Equal(403, error.Status);
        Assert.Single(http.Requests);
    }

    [Fact]
    public async Task A_render_without_output_is_not_ready()
    {
        var (client, http) = Client((_, _) => Answers.Json("{}"));

        var error = await Assert.ThrowsAsync<FormfeedException>(
            () => client.Renders.DownloadAsync(Render.FromJson("""{"id":"rnd_2","status":"queued","download_url":null}""")));

        Assert.Equal("not_ready", error.Code);
        Assert.Empty(http.Requests);
    }

    [Fact]
    public async Task All_follows_the_cursor()
    {
        var (client, http) = Client((_, n) => Answers.Json(n == 1
            ? $$"""{"data":[{{RenderJson}},{{RenderWith("rnd_2")}}],"next_cursor":"c2"}"""
            : $$"""{"data":[{{RenderWith("rnd_3")}}],"next_cursor":null}"""));

        var ids = new List<string>();
        await foreach (var render in client.Renders.ListAllAsync(new RenderListQuery { Status = "failed" }))
        {
            ids.Add(render.Id);
        }

        Assert.Equal(["rnd_1", "rnd_2", "rnd_3"], ids);
        Assert.Equal("https://api-eu.formfeed.dev/v1/renders?status=failed", http[0].Uri);
        Assert.Equal("https://api-eu.formfeed.dev/v1/renders?status=failed&cursor=c2", http[1].Uri);
    }

    [Fact]
    public async Task A_list_query_names_its_filters_and_page()
    {
        var (client, http) = Client((_, _) => Answers.Json("""{"data":[],"next_cursor":null}"""));

        var page = await client.Renders.ListAsync(new RenderListQuery
        {
            Template = "invoice",
            Since = new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.Zero),
            Until = new DateTimeOffset(2026, 11, 2, 12, 30, 0, TimeSpan.FromHours(1)),
            Limit = 50,
            Cursor = "c9",
        });
        await client.Templates.ListAsync(new TemplateListQuery { Search = "Rechnung DE", Tag = "de" });
        await client.Files.ListAsync(new FileListQuery { Prefix = "brand/" });

        Assert.Empty(page.Data);
        Assert.Null(page.NextCursor);
        Assert.Equal(
            "https://api-eu.formfeed.dev/v1/renders?template=invoice&since=2026-11-01T00%3A00%3A00Z&until=2026-11-02T12%3A30%3A00%2B01%3A00&limit=50&cursor=c9",
            http[0].Uri);
        Assert.Equal("https://api-eu.formfeed.dev/v1/templates?tag=de&q=Rechnung%20DE", http[1].Uri);
        Assert.Equal("https://api-eu.formfeed.dev/v1/files?prefix=brand%2F", http[2].Uri);
    }

    [Fact]
    public async Task An_upload_goes_as_multipart_beside_the_options()
    {
        var (client, http) = Client((_, _) => Answers.Json(RenderJson));

        await client.Pdf.RedactAsync(
            Upload.FromBytes(Encoding.ASCII.GetBytes("%PDF-1.7 bytes"), "contract.pdf"),
            new RedactOptions
            {
                Regions = [new RedactRegion { Page = 1, X = 10, Y = 20, Width = 100, Height = 12.5 }],
                WholeWords = true,
                NoFill = true,
                ExpiresIn = null,
            });

        var request = http[0];
        Assert.Equal("https://api-eu.formfeed.dev/v1/pdf/redact", request.Uri);
        Assert.Matches(Uuid, request.Header("Idempotency-Key"));
        Assert.Equal(
            [
                ("file", "contract.pdf", "application/pdf", "%PDF-1.7 bytes"),
                ("regions", null, null, """[{"page":1,"x":10,"y":20,"width":100,"height":12.5}]"""),
                ("whole_words", null, null, "true"),
                ("fill", null, null, "null"),
            ],
            Parts(request));
    }

    [Fact]
    public async Task A_stored_source_goes_as_json()
    {
        var (client, http) = Client((_, n) => Answers.Json(n == 1
            ? """{"source":"rnd_9","page_count":2,"pages":[{"width_pt":595.28,"height_pt":841.89,"width_mm":210,"height_mm":297},"x"],"encrypted":false,"metadata":{"title":"Fennlor Studio"}}"""
            : RenderJson));

        var info = await client.Pdf.GetInfoAsync("rnd_9");
        await client.Pdf.CompressAsync(ARender(), new CompressOptions { Filename = "small" });

        Assert.Equal(2, info.PageCount);
        Assert.Equal(210, Assert.Single(info.Pages).WidthMm);
        Assert.Equal("Fennlor Studio", info.Metadata["title"].GetString());
        Assert.Equal("""{"source":"rnd_9"}""", http[0].Text);
        Assert.False(http[0].HasHeader("Idempotency-Key"));
        Assert.Equal("""{"filename":"small","source":"rnd_1"}""", http[1].Text);
        Assert.True(http[1].HasHeader("Idempotency-Key"));
    }

    [Fact]
    public async Task A_merge_takes_renders_and_library_files()
    {
        var (client, http) = Client((_, _) => Answers.Json(RenderJson));

        await client.Pdf.MergeAsync([ARender(), "fil_2", "terms.pdf"], new MergeOptions { Filename = "contract" });

        Assert.Equal("""{"filename":"contract","sources":["rnd_1","fil_2","terms.pdf"]}""", http[0].Text);
    }

    [Fact]
    public async Task Every_pdf_tool_names_its_path_and_its_options()
    {
        var (client, http) = Client((_, _) => Answers.Json(RenderJson));
        var render = ARender();

        await client.Pdf.ProtectAsync(render, new ProtectOptions { UserPassword = "open", Permissions = ["print"] });
        await client.Pdf.WatermarkAsync("fil_1", new WatermarkOptions { Text = "DRAFT", Opacity = 0.3 });
        await client.Pdf.SplitAsync(render, new SplitOptions { Ranges = ["1-2", "3-"] });
        await client.Pdf.ToImageAsync(render, new ToImageOptions { Format = "png", Dpi = 72 });
        await client.Pdf.FillAsync(render, new FillOptions
        {
            Fields = new Dictionary<string, object?> { ["name"] = "Erika Mustermann", ["accepted"] = true },
            Flatten = true,
        });
        await client.Pdf.ConvertAsync(Upload.FromBytes(new byte[] { 0x50, 0x4b }, "offer.docx"), new ConvertOptions { Landscape = true });

        Assert.Equal(
            [
                "/pdf/protect " + """{"user_password":"open","permissions":["print"],"source":"rnd_1"}""",
                "/pdf/watermark " + """{"text":"DRAFT","opacity":0.3,"source":"fil_1"}""",
                "/pdf/split " + """{"ranges":["1-2","3-"],"source":"rnd_1"}""",
                "/pdf/to-image " + """{"format":"png","dpi":72,"source":"rnd_1"}""",
                "/pdf/fill " + """{"fields":{"name":"Erika Mustermann","accepted":true},"flatten":true,"source":"rnd_1"}""",
            ],
            http.Requests.Take(5).Select(r => r.Uri["https://api-eu.formfeed.dev/v1".Length..] + " " + r.Text));
        Assert.All(http.Requests, r => Assert.Matches(Uuid, r.Header("Idempotency-Key")));
        Assert.Equal(
            [
                ("file", "offer.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK"),
                ("landscape", null, null, "true"),
            ],
            Parts(http[5]));
    }

    [Fact]
    public async Task A_library_upload_names_the_file()
    {
        var (client, http) = Client((_, _) => Answers.Json(
            """{"id":"fil_1","name":"logo.png","content_type":"image/png","bytes":4,"sha256":"ab","url":"https://cdn.formfeed.test/a/logo.png","created_at":"2026-11-18T10:00:00Z","updated_at":"2026-11-18T10:00:00Z"}""",
            201));

        var file = await client.Files.UploadAsync(Upload.FromBytes(Encoding.ASCII.GetBytes("PNG!"), "logo.png"));

        Assert.Equal("fil_1", file.Id);
        Assert.Equal(4, file.Bytes);
        Assert.False(http[0].HasHeader("Idempotency-Key"));
        Assert.Equal([("file", "logo.png", "image/png", "PNG!"), ("name", null, null, "logo.png")], Parts(http[0]));
    }

    [Fact]
    public async Task An_einvoice_is_validated_by_its_render_or_as_an_upload()
    {
        var (client, http) = Client((_, _) => Answers.Json("""{"valid":true}"""));

        var report = await client.Einvoices.ValidateAsync("rnd_1", "xrechnung");
        await client.Einvoices.ValidateAsync(Upload.FromBytes(Encoding.UTF8.GetBytes("<Invoice/>"), "invoice.xml"));

        Assert.True(report.GetProperty("valid").GetBoolean());
        Assert.Equal("""{"render_id":"rnd_1","rules":"xrechnung"}""", http[0].Text);
        Assert.Matches(Uuid, http[0].Header("Idempotency-Key"));
        Assert.Equal([("file", "invoice.xml", "application/xml", "<Invoice/>")], Parts(http[1]));
        Assert.Matches(Uuid, http[1].Header("Idempotency-Key"));
    }

    [Fact]
    public async Task A_deletion_answers_nothing()
    {
        var (client, http) = Client((_, _) => Answers.Empty(204));

        await client.Files.DeleteAsync("fil_1");
        await client.Renders.DeleteOutputsAsync(ARender());

        Assert.Equal("DELETE", http[0].Method);
        Assert.Equal("https://api-eu.formfeed.dev/v1/files/fil_1", http[0].Uri);
        Assert.Equal("https://api-eu.formfeed.dev/v1/renders/rnd_1/outputs", http[1].Uri);
        Assert.Empty(http[0].Body);
    }

    [Fact]
    public async Task Webhook_endpoints_are_listed_created_and_updated()
    {
        var (client, http) = Client((_, n) => Answers.Json(n == 1
            ? """{"data":[{"id":"whk_1","url":"https://example.test/hook","events":["render.completed",3],"enabled":true}]}"""
            : """{"id":"whk_1","url":"https://example.test/hook","events":["render.completed"],"enabled":false,"secret":"whsec_1"}"""));

        var endpoints = await client.Webhooks.ListAsync();
        var created = await client.Webhooks.CreateAsync(new WebhookCreate { Url = "https://example.test/hook", Events = ["render.completed"] });
        await client.Webhooks.UpdateAsync("whk_1", new WebhookUpdate { Enabled = false, ClearDescription = true });
        await client.Webhooks.ResendAsync("evt_1", "whk_1");

        Assert.Equal(["render.completed"], Assert.Single(endpoints).Events);
        Assert.Equal("whsec_1", created.Secret);
        Assert.Equal("""{"url":"https://example.test/hook","events":["render.completed"]}""", http[1].Text);
        Assert.False(http[1].HasHeader("Idempotency-Key"));
        Assert.Equal("PUT", http[2].Method);
        Assert.Equal("""{"enabled":false,"description":null}""", http[2].Text);
        Assert.Equal("https://api-eu.formfeed.dev/v1/webhooks/events/evt_1/resend", http[3].Uri);
        Assert.Equal("""{"endpoint_id":"whk_1"}""", http[3].Text);
    }

    [Fact]
    public async Task A_template_schema_names_its_version()
    {
        var (client, http) = Client((_, _) => Answers.Json("""{"type":"object"}"""));

        await client.Templates.GetSchemaAsync("invoice", "staging");
        await client.Templates.GetSchemaAsync("invoice");
        await client.Templates.ValidateAsync("invoice");

        Assert.Equal("https://api-eu.formfeed.dev/v1/templates/invoice/schema?version=staging", http[0].Uri);
        Assert.Equal("https://api-eu.formfeed.dev/v1/templates/invoice/schema", http[1].Uri);
        Assert.Equal("{}", http[2].Text);
    }

    [Fact]
    public async Task Usage_reads_its_period()
    {
        var (client, http) = Client((_, _) => Answers.Json(
            """{"period":"2026-11","period_start":"2026-11-01","period_end":"2026-12-01","included":1000,"used":12.5,"overage_used":0,"overage_balance":0,"hard_cap_units":null,"daily":[{"date":"2026-11-18","units":12.5,"renders":14}],"by_template":[{"template":"invoice","units":12.5}]}"""));

        var usage = await client.Account.GetUsageAsync();

        Assert.Equal("https://api-eu.formfeed.dev/v1/usage?period=current", http[0].Uri);
        Assert.Equal(12.5, usage.Used);
        Assert.Null(usage.HardCapUnits);
        Assert.Equal(14, Assert.Single(usage.Daily).Renders);
        Assert.Equal("invoice", Assert.Single(usage.ByTemplate).Template);
    }

    [Fact]
    public async Task Request_reaches_a_call_without_a_method()
    {
        var (client, http) = Client((_, _) => Answers.Json("""{"name":"Fennlor Studio GmbH"}"""));

        var brand = await client.RequestAsync(HttpMethod.Get, "/brand");

        Assert.Equal("Fennlor Studio GmbH", brand?.GetProperty("name").GetString());
        Assert.Equal("https://api-eu.formfeed.dev/v1/brand", http[0].Uri);
        Assert.False(http[0].HasHeader("Idempotency-Key"));
    }

    [Fact]
    public async Task Request_sends_a_body_of_dictionaries_json_values_and_requests()
    {
        var (client, http) = Client((_, n) => n == 1 ? Answers.Json("{}", 201) : Answers.Empty(204));

        var created = await client.RequestAsync(
            HttpMethod.Post,
            "/templates/invoice/versions",
            new Dictionary<string, object?>
            {
                ["sample_data"] = JsonNode.Parse("""{"customer":{"name":"Olvarest GmbH"}}"""),
                ["tags"] = new[] { "de", "invoice" },
                ["total"] = 1428.5m,
                ["when"] = new DateTimeOffset(2026, 11, 18, 10, 0, 0, TimeSpan.Zero),
                ["note"] = null,
            },
            "key-1");
        var none = await client.RequestAsync(HttpMethod.Post, "/renders", new RenderRequest { Markdown = "# Ü" });

        Assert.Equal(JsonValueKind.Object, created?.ValueKind);
        Assert.Null(none);
        Assert.Equal(
            """{"sample_data":{"customer":{"name":"Olvarest GmbH"}},"tags":["de","invoice"],"total":1428.5,"when":"2026-11-18T10:00:00+00:00","note":null}""",
            http[0].Text);
        Assert.Equal("key-1", http[0].Header("Idempotency-Key"));
        Assert.Equal("""{"markdown":"# Ü"}""", http[1].Text);
    }

    [Fact]
    public async Task Data_of_your_own_types_is_written_with_the_serializer_options()
    {
        var (client, http) = Client((_, _) => Answers.Json(RenderJson));

        await client.Renders.CreateAsync(new RenderRequest
        {
            Template = "invoice",
            Data = new Dictionary<string, object?> { ["customer"] = new Customer { Name = "Olvarest GmbH", Vat = "DE000000000" } },
            AdditionalFields = new Dictionary<string, object?> { ["template"] = "invoice-de", ["region"] = null },
        });

        Assert.Equal("""{"template":"invoice-de","data":{"customer":{"Name":"Olvarest GmbH","Vat":"DE000000000"}},"region":null}""", http[0].Text);
    }

    [Fact]
    public async Task A_batch_sends_its_items_as_render_requests()
    {
        var (client, http) = Client((_, _) => Answers.Json(
            $$$"""{"id":"job_1","type":"batch","status":"queued","total":2,"items":[{{{RenderWith("rnd_1", "queued")}}},{{{RenderWith("rnd_2", "queued")}}}],"meta":{"run":"nightly"}}""",
            202));

        var job = await client.Renders.CreateBatchAsync(new BatchRequest
        {
            Template = "invoice",
            Zip = true,
            Items =
            [
                new RenderRequest { Data = new Dictionary<string, object?> { ["n"] = 1 } },
                new RenderRequest { Data = new Dictionary<string, object?> { ["n"] = 2 }, Filename = "two" },
            ],
        });

        Assert.Equal("job_1", job.Id);
        Assert.False(job.IsFinished);
        Assert.Equal(2, job.Items.Count);
        Assert.Equal("nightly", job.Meta["run"].GetString());
        Assert.Equal("https://api-eu.formfeed.dev/v1/renders/batch", http[0].Uri);
        Assert.Matches(Uuid, http[0].Header("Idempotency-Key"));
        Assert.Equal("""{"template":"invoice","items":[{"data":{"n":1}},{"data":{"n":2},"filename":"two"}],"zip":true}""", http[0].Text);
    }

    [Fact]
    public async Task A_timeout_is_a_network_error_that_is_retried()
    {
        var (client, http) = Client(
            async (_, _, cancellationToken) =>
            {
                await Task.Delay(Timeout.Infinite, cancellationToken);
                return Answers.Json("{}");
            },
            maxRetries: 1,
            timeout: TimeSpan.FromMilliseconds(50));

        var error = await Assert.ThrowsAsync<FormfeedException>(() => client.Account.GetAsync());

        Assert.Equal("network_error", error.Code);
        Assert.Equal(0, error.Status);
        Assert.Equal(2, http.Requests.Count);
        Assert.Single(Waits);
    }

    [Fact]
    public async Task A_call_you_cancel_is_cancelled_and_not_retried()
    {
        using var cancel = new CancellationTokenSource();
        var (client, http) = Client(
            async (_, _, cancellationToken) =>
            {
                await cancel.CancelAsync();
                await Task.Delay(Timeout.Infinite, cancellationToken);
                return Answers.Json("{}");
            });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.Account.GetAsync(cancel.Token));

        Assert.Single(http.Requests);
        Assert.Empty(Waits);
    }

    [Fact]
    public async Task Headers_of_the_options_go_after_the_sdks_own()
    {
        var http = new StubHandler((_, _, _) => Task.FromResult(Answers.Json("{}")));
        var options = new FormfeedClientOptions { ApiKey = "ff_test_k" };
        options.Headers["User-Agent"] = "fennlor-billing/2.0";
        options.Headers["X-Trace"] = "t-1";
        using var httpClient = new HttpClient(http);
        using var client = new FormfeedClient(options, httpClient);

        await client.Account.GetAsync();

        Assert.Equal("fennlor-billing/2.0", http[0].Header("User-Agent"));
        Assert.Equal("t-1", http[0].Header("X-Trace"));
        Assert.Equal("Bearer ff_test_k", http[0].Header("Authorization"));
    }

    [Fact]
    public async Task A_client_you_pass_stays_yours()
    {
        var http = new StubHandler((_, _, _) => Task.FromResult(Answers.Json("{}")));
        using var httpClient = new HttpClient(http);

        using (var client = new FormfeedClient("ff_test_k", httpClient))
        {
            await client.Account.GetAsync();
        }
        using var second = new FormfeedClient("ff_test_k", httpClient);

        Assert.Equal(JsonValueKind.Object, (await second.Account.GetAsync()).ValueKind);
        Assert.Equal(2, http.Requests.Count);
    }

    [Fact]
    public async Task An_answer_that_is_not_json_is_an_invalid_response()
    {
        var (client, _) = Client((_, _) => Answers.Bytes(Encoding.ASCII.GetBytes("<html>"), "text/html"));

        var error = await Assert.ThrowsAsync<FormfeedException>(() => client.Renders.GetAsync("rnd_1"));

        Assert.Equal("invalid_response", error.Code);
        Assert.Equal(200, error.Status);
    }

    [Fact]
    public void A_model_reads_what_it_can_and_keeps_the_rest()
    {
        var render = Render.FromJson(
            """{"id":"rnd_1","status":"rendering_v2","output":null,"bytes":"many","units":0.5,"page_count":2.0,"meta":[1],"template":{"slug":"invoice","version":4,"channel":"staging"},"error":{"code":"x","message":"y","line":3},"future":{"a":1}}""");

        Assert.Equal("rendering_v2", render.Status);
        Assert.False(render.IsFinished);
        Assert.Equal("", render.Output);
        Assert.Null(render.Bytes);
        Assert.Equal(2, render.PageCount);
        Assert.Equal(0.5, render.Units);
        Assert.Empty(render.Meta);
        Assert.Equal("staging", render.Template?.Channel);
        Assert.Equal("x", render.Error?.Code);
        Assert.Equal(3, render.Error?.Details?["line"].GetInt32());
        Assert.Equal(1, render.Raw.GetProperty("future").GetProperty("a").GetInt32());
        Assert.Equal(default, render.CreatedAt);
    }

    [Fact]
    public void A_webhook_delivery_is_parsed_once_its_signature_holds()
    {
        const string secret = "whsec_mock_secret_123456";
        var body = """{"id":"evt_1","type":"render.completed","created_at":"2026-09-18T12:00:00Z","workspace_id":"ws_1","data":"""
            + RenderJson + "}";
        var now = DateTimeOffset.FromUnixTimeSeconds(1_795_000_000);
        using var hmac = new System.Security.Cryptography.HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var signature = string.Concat(hmac.ComputeHash(Encoding.UTF8.GetBytes("1795000000." + body)).Select(b => b.ToString("x2", CultureInfo.InvariantCulture)));

        var webhookEvent = Webhook.Parse(secret, $"t=1795000000,v1={signature}", body, now: now);

        Assert.Equal("render.completed", webhookEvent.Type);
        Assert.Equal("ws_1", webhookEvent.WorkspaceId);
        Assert.Equal("rnd_1", Render.FromJson(webhookEvent.Data).Id);
        Assert.Throws<WebhookSignatureException>(() => Webhook.Parse(secret, $"t=1795000000,v1={signature}", body + " ", now: now));
        Assert.Throws<WebhookSignatureException>(() => Webhook.Parse(secret, $"t=1795000000,v1={signature}", body, now: now.AddMinutes(6)));
        Assert.NotNull(Webhook.Parse(secret, $"t=1795000000,v1={signature}", body, TimeSpan.FromMinutes(10), now.AddMinutes(6)));
    }

    [Fact]
    public void An_upload_takes_its_type_from_its_name()
    {
        Assert.Equal("application/pdf", Upload.FromBytes(Array.Empty<byte>(), "a.PDF").ContentType);
        Assert.Equal("application/octet-stream", Upload.FromBytes(Array.Empty<byte>(), "a").ContentType);
        Assert.Equal("text/csv", Upload.FromBytes(Array.Empty<byte>(), "a.csv", "text/csv").ContentType);
    }

    /// <summary>net10.0 tests the library's net10.0 build, net8.0 its netstandard2.0 build.</summary>
    [Fact]
    public void Each_framework_tests_its_build_of_the_library()
    {
        var framework = typeof(FormfeedClient).Assembly.GetCustomAttribute<TargetFrameworkAttribute>()?.FrameworkName;
#if NET10_0_OR_GREATER
        Assert.Equal(".NETCoreApp,Version=v10.0", framework);
#else
        Assert.Equal(".NETStandard,Version=v2.0", framework);
#endif
    }

    /// <summary>The assembly carries the version the client names, which the csproj sets.</summary>
    [Fact]
    public void The_assembly_is_the_client_version() =>
        Assert.Equal(new Version(FormfeedClient.Version + ".0"), typeof(FormfeedClient).Assembly.GetName().Version);

    /// <summary>One version for every package (plan 34, decision 6): the release bumps this one too.</summary>
    [Fact]
    public void The_version_is_the_releases_one()
    {
        var publish = Path.Combine(Paths.Repository, "tools", "publish", "packages.mjs");
        Assert.SkipUnless(File.Exists(publish), "outside the Formfeed repository, which holds the release version");
        Assert.Contains($"export const VERSION = '{FormfeedClient.Version}';", File.ReadAllText(publish), StringComparison.Ordinal);
    }

    private sealed class Customer
    {
        public string Name { get; set; } = "";

        public string Vat { get; set; } = "";
    }
}
