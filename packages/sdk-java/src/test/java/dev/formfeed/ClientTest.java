package dev.formfeed;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class ClientTest extends ClientTestCase {
  private static final Pattern UUID =
      Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

  @Test
  void aRenderSendsTheKeyAnIdempotencyKeyAndJson() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(RENDER, 201));

    Render render =
        client(api)
            .renders()
            .create(RenderRequest.template("invoice").data(Map.of("a", 1)).output("pdf"));

    assertEquals("rnd_1", render.getId());
    assertTrue(render.isFinished());
    assertEquals(1, render.getPageCount());
    assertEquals(5681L, render.getBytes());
    assertEquals("invoice", render.getTemplate().get("slug"));
    StubApi.Seen request = api.request(0);
    assertEquals("POST", request.method);
    assertEquals("/v1/renders", request.target);
    assertEquals("Bearer ff_test_k", request.header("Authorization"));
    assertEquals("formfeed-sdk-java/0.3", request.header("User-Agent"));
    assertEquals("application/json", request.header("Accept"));
    assertEquals("application/json", request.header("Content-Type"));
    assertTrue(UUID.matcher(request.header("Idempotency-Key")).matches());
    assertEquals(
        Map.of("template", "invoice", "data", Map.of("a", 1), "output", "pdf"), body(request));
  }

  @Test
  void aRenderTakesAPlainMapToo() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(RENDER, 201));

    client(api).renders().create(Map.of("html", "<p>x</p>", "output", "png"));

    assertEquals(Map.of("html", "<p>x</p>", "output", "png"), body(api.request(0)));
  }

  @Test
  void emptyDataIsSentAsAnObject() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(RENDER, 201));

    client(api).renders().create(RenderRequest.template("invoice").data(Map.of()));

    assertEquals("{\"template\":\"invoice\",\"data\":{}}", api.request(0).text());
  }

  @Test
  void aGivenIdempotencyKeyIsSentAsItIs() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(RENDER, 201));

    client(api).renders().create(RenderRequest.html("<p>x</p>"), "order-1234");

    assertEquals("order-1234", api.request(0).header("Idempotency-Key"));
  }

  @Test
  void theRegionOrABaseUrlNamesTheHost() {
    assertEquals(
        "https://api-eu.formfeed.dev/v1", Formfeed.builder().apiKey("ff_test_k").build().baseUrl());
    assertEquals(
        "https://api-us.formfeed.dev/v1",
        Formfeed.builder().apiKey("ff_test_k").region("us").build().baseUrl());

    StubApi api = stub((request, n) -> StubApi.Answer.json(RENDER));
    Formfeed.builder()
        .apiKey("ff_test_k")
        .region("us")
        .baseUrl(api.baseUrl() + "/")
        .build()
        .renders()
        .get("rnd_1");
    assertEquals("/v1/renders/rnd_1", api.request(0).target);
  }

  @Test
  void anUnknownRegionIsRefused() {
    FormfeedException e =
        assertThrows(
            FormfeedException.class,
            () -> Formfeed.builder().apiKey("ff_test_k").region("ap").build());
    assertEquals("invalid_request", e.getCode());
    assertTrue(e.getMessage().contains("unknown region"));
  }

  @Test
  void anApiKeyIsRequired() {
    FormfeedException e =
        assertThrows(FormfeedException.class, () -> Formfeed.builder().apiKey("").build());
    assertEquals("invalid_request", e.getCode());
  }

  @Test
  void aProblemBecomesOneException() {
    Map<String, Object> problem = new LinkedHashMap<>();
    problem.put("type", "https://docs.formfeed.dev/errors/quota-exceeded");
    problem.put("title", "Quota exceeded");
    problem.put("status", 402);
    problem.put("detail", "The period has no units left.");
    problem.put("code", "quota_exceeded");
    problem.put("period_end", "2026-12-01");
    StubApi api = stub((request, n) -> StubApi.Answer.json(problem, 402, "X-Request-Id", "req_9"));

    FormfeedException e =
        assertThrows(
            FormfeedException.class,
            () -> client(api).renders().create(RenderRequest.template("invoice")));

    assertEquals("quota_exceeded", e.getCode());
    assertEquals("The period has no units left.", e.getMessage());
    assertEquals(402, e.getStatus());
    assertEquals("req_9", e.getRequestId());
    assertEquals("Quota exceeded", e.getProblem().getTitle());
    assertEquals("quota_exceeded", e.getProblem().getCode());
    assertEquals("2026-12-01", e.getProblem().getRaw().get("period_end"));
  }

  @Test
  void aRetrySendsTheSameIdempotencyKey() {
    StubApi api =
        stub((request, n) ->
            n == 1
                ? StubApi.Answer.json(Map.of("code", "rate_limited"), 429, "Retry-After", "1")
                : StubApi.Answer.json(RENDER, 201));
    Formfeed formfeed =
        Formfeed.builder().apiKey("ff_test_k").baseUrl(api.baseUrl()).sleeper(waits::add).build();

    formfeed.renders().create(RenderRequest.template("invoice"));

    assertEquals(2, api.requests().size());
    assertEquals(
        api.request(0).header("Idempotency-Key"), api.request(1).header("Idempotency-Key"));
    assertEquals(api.request(0).text(), api.request(1).text());
    assertEquals(1, waits.size());
    assertTrue(millis(waits.get(0)) >= 1000 && millis(waits.get(0)) <= 1250, waits.toString());
  }

  @Test
  void aBatchAndTheToolsThatRenderSendAnIdempotencyKey() {
    StubApi api =
        stub((request, n) ->
            request.target.startsWith("/v1/renders/batch")
                ? StubApi.Answer.json(Map.of("id", "job_1", "status", "queued", "total", 2), 202)
                : StubApi.Answer.json(RENDER));
    Formfeed formfeed = client(api);

    Job job =
        formfeed
            .renders()
            .batch(
                Map.of(
                    "template",
                    "invoice",
                    "items",
                    List.of(
                        Map.of("data", Map.of("n", 1)),
                        RenderRequest.template("receipt").data(Map.of("n", 2)))));
    formfeed.pdf().protect("rnd_1", Map.of("user_password", "secret"));
    formfeed.webhooks().test("whk_1");

    assertEquals("job_1", job.getId());
    assertFalse(job.isFinished());
    assertEquals(
        List.of(
            Map.of("data", Map.of("n", 1)), Map.of("template", "receipt", "data", Map.of("n", 2))),
        body(api.request(0)).get("items"));
    assertTrue(UUID.matcher(api.request(0).header("Idempotency-Key")).matches());
    assertTrue(UUID.matcher(api.request(1).header("Idempotency-Key")).matches());
    assertNull(api.request(2).header("Idempotency-Key"));
    assertNull(api.request(2).header("Content-Type"));
  }

  @Test
  void waitForPollsUntilTheRenderIsFinished() {
    StubApi api =
        stub((request, n) ->
            StubApi.Answer.json(n < 3 ? Map.of("id", "rnd_1", "status", "processing") : RENDER));

    Render render = client(api).renders().waitFor("rnd_1");

    assertEquals("succeeded", render.getStatus());
    assertEquals(3, api.requests().size());
    assertEquals(List.of(Duration.ofSeconds(1), Duration.ofSeconds(1)), waits);
  }

  @Test
  void waitForEndsAtItsTimeout() {
    StubApi api =
        stub((request, n) -> StubApi.Answer.json(Map.of("id", "rnd_1", "status", "queued")));

    FormfeedException e =
        assertThrows(
            FormfeedException.class,
            () ->
                client(api)
                    .renders()
                    .waitFor("rnd_1", Duration.ofSeconds(3), Duration.ofSeconds(1)));

    assertEquals("timeout", e.getCode());
    assertEquals(
        List.of(Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofSeconds(1)), waits);
    assertEquals(4, api.requests().size());
  }

  @Test
  void aJobIsAwaitedToo() {
    StubApi api =
        stub((request, n) ->
            StubApi.Answer.json(
                Map.of(
                    "id",
                    "job_1",
                    "status",
                    n < 2 ? "processing" : "completed",
                    "total",
                    1,
                    "items",
                    List.of(RENDER))));

    Job job = client(api).jobs().waitFor("job_1");

    assertEquals("completed", job.getStatus());
    assertEquals("rnd_1", job.getItems().get(0).getId());
    assertEquals(List.of(Duration.ofSeconds(2)), waits);
    assertEquals("/v1/jobs/job_1", api.request(0).target);
  }

  @Test
  void aDownloadFollowsTheSignedLinkWithoutTheKey() {
    StubApi cdn =
        stub((request, n) ->
            StubApi.Answer.bytes(
                200,
                "%PDF-1.7".getBytes(StandardCharsets.UTF_8),
                "Content-Type",
                "application/pdf"));
    StubApi api = stub((request, n) -> StubApi.Answer.json(Map.of()));
    Map<String, Object> render = new LinkedHashMap<>(RENDER);
    render.put("download_url", cdn.url() + "/o/x.pdf?exp=1&sig=2");

    byte[] bytes = client(api).renders().download(Render.fromMap(render));

    assertArrayEquals("%PDF-1.7".getBytes(StandardCharsets.UTF_8), bytes);
    assertEquals("/o/x.pdf?exp=1&sig=2", cdn.request(0).target);
    assertNull(cdn.request(0).header("Authorization"));
    assertTrue(api.requests().isEmpty());
  }

  @Test
  void aDownloadToAFileReplacesItOnlyWhenComplete(@TempDir Path folder) throws Exception {
    StubApi cdn =
        stub((request, n) ->
            n == 1
                ? StubApi.Answer.bytes(200, "%PDF-1.7 complete".getBytes(StandardCharsets.UTF_8))
                : StubApi.Answer.json(Map.of("code", "not_found"), 404));
    Map<String, Object> render = new LinkedHashMap<>(RENDER);
    render.put("download_url", cdn.url() + "/o/x.pdf");
    Path target = folder.resolve("invoice.pdf");
    Files.write(target, "an older and longer file".getBytes(StandardCharsets.UTF_8));
    Formfeed formfeed = client(stub((request, n) -> StubApi.Answer.json(Map.of())));

    long written = formfeed.renders().downloadTo(Render.fromMap(render), target);

    assertEquals(17, written);
    assertEquals("%PDF-1.7 complete", Files.readString(target));
    FormfeedException e =
        assertThrows(
            FormfeedException.class,
            () -> formfeed.renders().downloadTo(Render.fromMap(render), target));
    assertEquals("download_failed", e.getCode());
    assertEquals(404, e.getStatus());
    assertEquals("%PDF-1.7 complete", Files.readString(target));
    try (var left = Files.list(folder)) {
      assertEquals(1, left.count(), "no temporary file stays");
    }
    if (target.getFileSystem().supportedFileAttributeViews().contains("posix")) {
      // created as any new file is, not readable by its owner alone as a temporary file would be
      Path plain = Files.write(folder.resolve("plain"), new byte[0]);
      assertEquals(Files.getPosixFilePermissions(plain), Files.getPosixFilePermissions(target));
    }
  }

  @Test
  void aRenderWithoutOutputIsNotReady() {
    Formfeed formfeed = client(stub((request, n) -> StubApi.Answer.json(Map.of())));
    Map<String, Object> queued = new LinkedHashMap<>();
    queued.put("id", "rnd_2");
    queued.put("status", "queued");
    queued.put("download_url", null);

    FormfeedException e =
        assertThrows(
            FormfeedException.class, () -> formfeed.renders().download(Render.fromMap(queued)));

    assertEquals("not_ready", e.getCode());
  }

  @Test
  void allFollowsTheCursor() {
    StubApi api =
        stub((request, n) ->
            StubApi.Answer.json(
                n == 1
                    ? Map.of("data", List.of(RENDER, render("rnd_2")), "next_cursor", "c2")
                    : page(List.of(render("rnd_3")), null)));

    List<String> ids = new ArrayList<>();
    for (Render render : client(api).renders().all(Map.of("status", "failed"))) {
      ids.add(render.getId());
    }

    assertEquals(List.of("rnd_1", "rnd_2", "rnd_3"), ids);
    assertEquals("/v1/renders?status=failed", api.request(0).target);
    assertEquals("/v1/renders?status=failed&cursor=c2", api.request(1).target);
  }

  @Test
  void aQueryIsEncodedAsTheOtherSdksEncodeIt() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(page(List.of(), null)));
    Map<String, Object> query = new LinkedHashMap<>();
    query.put("q", "Fennlor Studio & Olvarest");
    query.put("limit", 50);
    query.put("tag", "");
    query.put("cursor", null);

    client(api).templates().list(query);

    assertEquals(
        "/v1/templates?q=Fennlor%20Studio%20%26%20Olvarest&limit=50", api.request(0).target);
  }

  @Test
  void anUploadGoesAsMultipartBesideTheOptions() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(RENDER));
    Map<String, Object> options = new LinkedHashMap<>();
    options.put(
        "regions", List.of(Map.of("page", 1, "x", 10, "y", 20, "width", 100, "height", 12)));
    options.put("fill", null);
    options.put("flatten", true);
    options.put("expires_in", null);

    client(api)
        .pdf()
        .redact(
            Upload.fromBytes("%PDF-1.7 bytes".getBytes(StandardCharsets.UTF_8), "contract.pdf"),
            options);

    StubApi.Seen request = api.request(0);
    assertEquals("/v1/pdf/redact", request.target);
    assertTrue(UUID.matcher(request.header("Idempotency-Key")).matches());
    Map<String, Object> parts = parts(request);
    assertEquals(List.of("file", "regions", "fill", "flatten"), new ArrayList<>(parts.keySet()));
    assertEquals(List.of("contract.pdf", "application/pdf", "%PDF-1.7 bytes"), parts.get("file"));
    assertEquals(
        List.of(Map.of("page", 1, "x", 10, "y", 20, "width", 100, "height", 12)),
        jsonOf((String) parts.get("regions")));
    assertEquals("null", parts.get("fill"));
    assertEquals("true", parts.get("flatten"));
  }

  @Test
  void aStoredSourceGoesAsJson() {
    StubApi api =
        stub((request, n) ->
            n == 1
                ? StubApi.Answer.json(
                    Map.of(
                        "source",
                        "rnd_9",
                        "page_count",
                        2,
                        "pages",
                        List.of(),
                        "encrypted",
                        false,
                        "metadata",
                        Map.of()))
                : StubApi.Answer.json(RENDER));
    Formfeed formfeed = client(api);

    PdfInfo info = formfeed.pdf().info("rnd_9");
    formfeed.pdf().compress(Render.fromMap(RENDER), Map.of("filename", "small"));

    assertEquals(2, info.getPageCount());
    assertFalse(info.isEncrypted());
    assertEquals(Map.of("source", "rnd_9"), body(api.request(0)));
    assertNull(api.request(0).header("Idempotency-Key"));
    assertEquals(Map.of("filename", "small", "source", "rnd_1"), body(api.request(1)));
    assertTrue(UUID.matcher(api.request(1).header("Idempotency-Key")).matches());
  }

  @Test
  void aMergeTakesRendersAndLibraryFiles() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(RENDER));
    LibraryFile file = LibraryFile.fromMap(Map.of("id", "fil_2", "name", "cover.pdf"));

    client(api)
        .pdf()
        .merge(List.of(Render.fromMap(RENDER), file, "terms.pdf"), Map.of("filename", "contract"));

    assertEquals(
        Map.of("filename", "contract", "sources", List.of("rnd_1", "fil_2", "terms.pdf")),
        body(api.request(0)));
  }

  @Test
  void aToolThatTakesStoredPdfsRefusesAnUpload() {
    Formfeed formfeed = client(stub((request, n) -> StubApi.Answer.json(RENDER)));
    Upload upload = Upload.fromBytes(new byte[] {1}, "a.pdf");

    assertThrows(
        IllegalArgumentException.class,
        () -> formfeed.pdf().protect(upload, Map.of("user_password", "secret")));
    assertThrows(IllegalArgumentException.class, () -> formfeed.pdf().merge(List.of(upload)));
  }

  @Test
  void anOfficeDocumentIsConvertedFromAnUpload() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(RENDER));

    client(api)
        .pdf()
        .convert(
            Upload.fromBytes("PK".getBytes(StandardCharsets.UTF_8), "offer.docx"),
            Map.of("filename", "offer"));

    Map<String, Object> parts = parts(api.request(0));
    assertEquals(
        List.of(
            "offer.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "PK"),
        parts.get("file"));
    assertEquals("offer", parts.get("filename"));
  }

  @Test
  void aLibraryUploadNamesTheFile() {
    StubApi api =
        stub((request, n) ->
            StubApi.Answer.json(
                Map.of(
                    "id", "fil_1",
                    "name", "logo.png",
                    "content_type", "image/png",
                    "bytes", 4,
                    "sha256", "ab",
                    "url", "https://cdn.formfeed.test/a/logo.png",
                    "created_at", "x",
                    "updated_at", "y"),
                201));
    byte[] png = {(byte) 0x89, 'P', 'N', 'G'};

    LibraryFile file = client(api).files().upload(Upload.fromBytes(png, "logo.png"));

    assertEquals("fil_1", file.getId());
    assertEquals(4, file.getBytes());
    Map<String, Object> parts = parts(api.request(0));
    assertEquals(
        List.of("logo.png", "image/png", new String(png, StandardCharsets.ISO_8859_1)),
        parts.get("file"));
    assertEquals("logo.png", parts.get("name"));
    assertNull(api.request(0).header("Idempotency-Key"));
  }

  @Test
  void aFileNameWithQuotesStaysOneHeader() {
    Multipart form =
        new Multipart(Map.of(), Upload.fromBytes(new byte[0], "a\"b\r\n.pdf"), Json.DEFAULT);
    String body = new String(form.body(), StandardCharsets.UTF_8);
    assertTrue(body.contains("filename=\"a%22b.pdf\""), body);
  }

  @Test
  void anEinvoiceIsValidatedByItsRender() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(Map.of("valid", true)));

    Map<String, Object> report = client(api).einvoices().validate("rnd_1", "xrechnung");

    assertEquals(true, report.get("valid"));
    assertEquals(Map.of("render_id", "rnd_1", "rules", "xrechnung"), body(api.request(0)));
    assertTrue(UUID.matcher(api.request(0).header("Idempotency-Key")).matches());
  }

  @Test
  void anEinvoiceUploadGoesAsMultipart() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(Map.of("valid", false)));

    client(api)
        .einvoices()
        .validate(Upload.fromBytes("<Invoice/>".getBytes(StandardCharsets.UTF_8), "invoice.xml"));

    Map<String, Object> parts = parts(api.request(0));
    assertEquals(List.of("invoice.xml", "application/xml", "<Invoice/>"), parts.get("file"));
    assertFalse(parts.containsKey("rules"));
  }

  @Test
  void aDeletionAnswersNothing() {
    StubApi api = stub((request, n) -> StubApi.Answer.empty(204));

    client(api).files().delete("fil_1");

    assertEquals("DELETE", api.request(0).method);
    assertEquals("/v1/files/fil_1", api.request(0).target);
  }

  @Test
  void webhookEndpointsAreListed() {
    StubApi api =
        stub((request, n) ->
            StubApi.Answer.json(
                Map.of(
                    "data",
                    List.of(
                        Map.of(
                            "id",
                            "whk_1",
                            "url",
                            "https://example.test/hook",
                            "events",
                            List.of("render.completed"),
                            "enabled",
                            true)))));

    List<WebhookEndpoint> endpoints = client(api).webhooks().list();

    assertEquals(1, endpoints.size());
    assertEquals(List.of("render.completed"), endpoints.get(0).getEvents());
    assertTrue(endpoints.get(0).isEnabled());
  }

  @Test
  void aTemplateSchemaNamesItsVersion() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(Map.of("type", "object")));
    Formfeed formfeed = client(api);

    formfeed.templates().schema("invoice", "staging");
    formfeed.templates().schema("invoice", 3);
    formfeed.templates().schema("invoice");

    assertEquals("/v1/templates/invoice/schema?version=staging", api.request(0).target);
    assertEquals("/v1/templates/invoice/schema?version=3", api.request(1).target);
    assertEquals("/v1/templates/invoice/schema", api.request(2).target);
  }

  @Test
  void usageAsksForItsPeriod() {
    StubApi api =
        stub((request, n) ->
            StubApi.Answer.json(
                Map.of(
                    "period", "2026-11", "included", 1000, "used", 12.5, "hard_cap_units", 3000)));

    Usage usage = client(api).account().usage();

    assertEquals("/v1/usage?period=current", api.request(0).target);
    assertEquals(12.5, usage.getUsed());
    assertEquals(3000.0, usage.getHardCapUnits());
  }

  @Test
  void aModelIgnoresWhatItDoesNotKnow() {
    Map<String, Object> later = new LinkedHashMap<>(RENDER);
    later.put("status", "archived");
    later.put("bytes", "many");
    later.put("something_new", Map.of("a", 1));

    Render render = Render.fromMap(later);

    assertEquals("archived", render.getStatus());
    assertFalse(render.isFinished());
    assertNull(render.getBytes());
    assertEquals(Map.of("a", 1), render.getRaw().get("something_new"));
    assertThrows(UnsupportedOperationException.class, () -> render.getMeta().put("x", 1));
  }

  @Test
  void requestReachesACallWithoutAMethod() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(Map.of("name", "Fennlor Studio GmbH")));

    Object brand = client(api).request("GET", "/brand");

    assertEquals(Map.of("name", "Fennlor Studio GmbH"), brand);
    assertEquals("/v1/brand", api.request(0).target);
  }

  @Test
  void aNetworkErrorWithoutRetriesSaysSo() {
    StubApi api = stub((request, n) -> StubApi.Answer.broken());

    FormfeedException e =
        assertThrows(FormfeedException.class, () -> client(api, 0, 0).request("GET", "/account"));

    assertEquals("network_error", e.getCode());
    assertEquals(0, e.getStatus());
    assertEquals(1, api.requests().size());
  }

  @Test
  void aSlowAnswerEndsAtTheTimeout() {
    StubApi api =
        stub((request, n) -> {
          Thread.sleep(2000);
          return StubApi.Answer.json(Map.of());
        });
    Formfeed formfeed =
        Formfeed.builder()
            .apiKey("ff_test_k")
            .baseUrl(api.baseUrl())
            .timeout(Duration.ofMillis(200))
            .maxRetries(0)
            .build();

    FormfeedException e =
        assertThrows(FormfeedException.class, () -> formfeed.request("GET", "/account"));

    assertEquals("network_error", e.getCode());
  }

  @Test
  void anAnswerThatIsNotJsonIsAnInvalidResponse() {
    StubApi api =
        stub((request, n) -> StubApi.Answer.bytes(200, "<html>".getBytes(StandardCharsets.UTF_8)));

    FormfeedException e = assertThrows(FormfeedException.class, () -> client(api).account().get());

    assertEquals("invalid_response", e.getCode());
    assertEquals(200, e.getStatus());
  }

  @Test
  void anInterruptedWaitEndsTheCallAndKeepsTheFlag() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(Map.of(), 503));
    Formfeed formfeed =
        Formfeed.builder()
            .apiKey("ff_test_k")
            .baseUrl(api.baseUrl())
            .sleeper(duration -> {
              throw new InterruptedException();
            })
            .build();

    FormfeedException e =
        assertThrows(FormfeedException.class, () -> formfeed.request("GET", "/account"));

    assertEquals("interrupted", e.getCode());
    assertTrue(Thread.interrupted(), "the flag is kept (and cleared here)");
  }

  @Test
  void ownHeadersGoWithEveryRequest() {
    StubApi api = stub((request, n) -> StubApi.Answer.json(Map.of()));
    Formfeed.builder()
        .apiKey("ff_test_k")
        .baseUrl(api.baseUrl())
        .header("X-Request-Id", "req_mine")
        .build()
        .account()
        .get();

    assertEquals("req_mine", api.request(0).header("X-Request-Id"));
  }

  @Test
  void aWebhookDeliveryIsParsed() {
    String secret = "whsec_test";
    String body =
        "{\"id\":\"evt_1\",\"type\":\"render.completed\",\"workspace_id\":\"ws_1\",\"data\":"
            + "{\"id\":\"rnd_1\",\"status\":\"succeeded\"}}";
    long now = 1_795_000_000L;
    String header = "t=" + now + ",v1=" + hex(secret, now + "." + body);

    WebhookEvent event = Webhook.parse(secret, header, body, 300, now);

    assertEquals("render.completed", event.getType());
    assertEquals("rnd_1", Render.fromMap(event.getData()).getId());
    assertThrows(
        IllegalArgumentException.class, () -> Webhook.parse(secret, header, body + " ", 300, now));
    assertFalse(Webhook.verify("", header, body, 300, now));
  }

  /** One version for every package (plan 34, decision 6): the release bumps this one too. */
  @Test
  void theVersionIsTheReleasesOne() throws Exception {
    Path publish = packageDir().resolve("../../tools/publish/packages.mjs").normalize();
    Assumptions.assumeTrue(
        Files.isRegularFile(publish),
        "outside the Formfeed repository, which holds the release version");
    assertTrue(
        Files.readString(publish).contains("export const VERSION = '" + Formfeed.VERSION + "';"),
        "tools/publish/packages.mjs names " + Formfeed.VERSION);
  }

  /** The pom, the README's coordinates and the user agent follow the same version. */
  @Test
  void thePackageNamesItsVersionEverywhere() throws Exception {
    Matcher pom =
        Pattern.compile("<artifactId>formfeed</artifactId>\\s*<version>([^<]+)</version>")
            .matcher(Files.readString(packageDir().resolve("pom.xml")));
    assertTrue(pom.find(), "pom.xml has a version");
    assertEquals(Formfeed.VERSION, pom.group(1), "pom.xml");
    String readme = Files.readString(packageDir().resolve("README.md"));
    assertTrue(readme.contains("<version>" + Formfeed.VERSION + "</version>"), "README, Maven");
    assertTrue(readme.contains("dev.formfeed:formfeed:" + Formfeed.VERSION), "README, Gradle");
    String minor = Formfeed.VERSION.substring(0, Formfeed.VERSION.lastIndexOf('.'));
    assertEquals("formfeed-sdk-java/" + minor, Transport.USER_AGENT);
  }

  private static Map<String, Object> page(List<?> data, String nextCursor) {
    Map<String, Object> page = new LinkedHashMap<>();
    page.put("data", data);
    page.put("next_cursor", nextCursor);
    return page;
  }

  private static Object jsonOf(String text) {
    try {
      return StubApi.JSON.readValue(text, Object.class);
    } catch (java.io.IOException e) {
      throw new java.io.UncheckedIOException(e);
    }
  }

  private static String hex(String secret, String message) {
    try {
      javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
      mac.init(
          new javax.crypto.spec.SecretKeySpec(
              secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      StringBuilder out = new StringBuilder();
      for (byte b : mac.doFinal(message.getBytes(StandardCharsets.UTF_8))) {
        out.append(String.format("%02x", b & 0xFF));
      }
      return out.toString();
    } catch (java.security.GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }
}
