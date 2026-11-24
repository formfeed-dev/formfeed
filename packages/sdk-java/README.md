# Formfeed for Java

The Java SDK for the [Formfeed](https://formfeed.dev/?utm_source=maven-central)
API: PDFs and images from templates, HTML, URLs or Markdown, and tools for existing PDFs. Java 11 or
newer; it sends with the JDK's own `java.net.http.HttpClient` and needs Jackson databind 2.x, which a
Spring application has already.

Maven:

```xml
<dependency>
  <groupId>dev.formfeed</groupId>
  <artifactId>formfeed</artifactId>
  <version>0.3.31</version>
</dependency>
```

Gradle:

```kotlin
implementation("dev.formfeed:formfeed:0.3.31")
```

## Render a document

```java
import dev.formfeed.Formfeed;
import dev.formfeed.Render;
import dev.formfeed.RenderRequest;
import java.nio.file.Path;
import java.util.Map;

Formfeed formfeed = Formfeed.builder().apiKey(System.getenv("FORMFEED_API_KEY")).build();

Render render = formfeed.renders().create(
    RenderRequest.template("invoice")
        .data(Map.of("customer", Map.of("name", "Olvarest GmbH"), "total", 1428.00)));
formfeed.renders().downloadTo(render, Path.of("invoice.pdf"));
```

`data` takes a map or any object Jackson writes as a JSON object, such as one of your own domain. A render is synchronous by default, so the answer is the finished render. With
`mode("async")` it comes back queued, and `waitFor` polls until it is done:

```java
Render queued = formfeed.renders().create(RenderRequest.html("<h1>Report</h1>").mode("async"));
Render done = formfeed.renders().waitFor(queued, Duration.ofMinutes(2), Duration.ofSeconds(1));
byte[] pdf = formfeed.renders().download(done);
```

`download` answers the bytes, `downloadTo` streams them into a file and replaces it only once the
download is complete. `renders().create` also takes the request as a plain map
(`Map.of("template", "invoice", "data", data)`), and `RenderRequest.set(...)` sends any field the
API documents that has no setter.

Every call that creates a render sends an `Idempotency-Key`, so a retry cannot charge twice; pass
your own as the last argument to tie it to your order. Lists are pages (`list`) or an `Iterable`
that follows the cursor (`all`):

```java
for (Render failed : formfeed.renders().all(Map.of("status", "failed", "since", "2026-11-01T00:00:00Z"))) {
    System.out.println(failed.getId() + " " + failed.getError().get("code"));
}
```

## Batches

Up to 1,000 renders as one job, which keeps the order of its items. An item is a render request, as
a map or a `RenderRequest`; the batch's `template` and `output` fill in what an item leaves out:

```java
Job job = formfeed.renders().batch(Map.of(
    "template", "invoice",
    "items", List.of(
        Map.of("data", Map.of("customer", Map.of("name", "Olvarest GmbH"))),
        Map.of("data", Map.of("customer", Map.of("name", "Fennlor Studio GmbH"))))));

job = formfeed.jobs().waitFor(job);
for (Render item : job.getItems()) {
    System.out.println(item.getId() + " " + item.getStatus());
}
```

Once it is done, `job.getZipUrl()` names a ZIP of every file.

## PDF tools

On a render, a file of the library, or an upload, which is never stored:

```java
import dev.formfeed.PdfInfo;
import dev.formfeed.Upload;

Upload form = Upload.fromPath(Path.of("form.pdf"));
PdfInfo info = formfeed.pdf().info(form);
Render filled = formfeed.pdf().fill(form, Map.of(
    "fields", Map.of("name", "Max Mustermann", "accepted", true),
    "flatten", true));
Render merged = formfeed.pdf().merge(List.of(filled, "terms.pdf"));
```

`merge`, `protect`, `watermark`, `split`, `compress`, `toImage`, `redact`, `fill`, `convert` and
`info`, and `einvoices().validate()` for an e-invoice's rules. An upload goes as multipart, the
options as form fields beside it; a stored source goes as JSON.

## Webhooks

`Webhook.parse` checks the signature (HMAC-SHA256, at most five minutes old, compared in constant
time) and throws `IllegalArgumentException` when it does not match; `Webhook.verify` answers true or
false. Hand it the body exactly as it arrived. In Spring Boot:

```java
import dev.formfeed.Render;
import dev.formfeed.Webhook;
import dev.formfeed.WebhookEvent;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
class FormfeedWebhookController {
    private final String secret = System.getenv("FORMFEED_WEBHOOK_SECRET");

    @PostMapping("/webhooks/formfeed")
    ResponseEntity<Void> receive(
            @RequestHeader(name = "Webhook-Signature", required = false) String signature,
            @RequestBody byte[] body) {
        WebhookEvent event;
        try {
            event = Webhook.parse(secret, signature, body);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(401).build();
        }
        if (event.getType().equals("render.completed")) {
            Render render = Render.fromMap(event.getData());
            // fetch render.getDownloadUrl(), mark the order as invoiced, …
        }
        return ResponseEntity.noContent().build();
    }
}
```

The body is taken as `byte[]`, so Spring hands it over untouched; a body that went through a JSON
mapper and back no longer matches its signature.

## Errors and retries

Every problem the API answers is a `FormfeedException`, unchecked, with the problem's `getCode()`
(`quota_exceeded`, `template_not_found`, …), the detail as its message, the HTTP `getStatus()`, the
`getRequestId()` support asks for, and the whole problem in `getProblem()`. 429 and 503 answers and
network errors are retried up to three times, waiting what `Retry-After` says, else half a second
doubling, plus up to 250 ms; every request may take 120 seconds.

```java
try {
    formfeed.renders().create(RenderRequest.template("invoice").data(data));
} catch (FormfeedException e) {
    log.warn("{} ({}): {} [{}]", e.getCode(), e.getStatus(), e.getMessage(), e.getRequestId());
}
```

## Options

```java
Formfeed formfeed = Formfeed.builder()
    .apiKey(System.getenv("FORMFEED_API_KEY"))
    .region("us")                    // eu (the default) or us
    .timeout(Duration.ofSeconds(60)) // per request, 120 s by default
    .maxRetries(5)
    .httpClient(yourHttpClient)      // with your own proxy, executor or TLS settings
    .objectMapper(yourObjectMapper)  // Spring's, so your data objects keep their modules
    .build();
```

One client serves any number of threads.

## Any other call

Template authoring, release channels and shared partials have no methods here yet;
`formfeed.request("GET", "/brand")` reaches any call of the API with the client's key, retries and
errors, and answers the decoded JSON as maps and lists. The [documentation](https://docs.formfeed.dev)
describes every call.

## License

MIT
