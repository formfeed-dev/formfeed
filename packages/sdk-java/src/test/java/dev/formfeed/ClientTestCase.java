package dev.formfeed;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.core.type.TypeReference;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;

abstract class ClientTestCase {
  /** A finished render as the API answers it. */
  static final Map<String, Object> RENDER = render("rnd_1");

  /** The seconds the client waited, in order. */
  final List<Duration> waits = new ArrayList<>();

  private final List<StubApi> stubs = new ArrayList<>();

  static Map<String, Object> render(String id) {
    Map<String, Object> render = new LinkedHashMap<>();
    render.put("id", id);
    render.put("status", "succeeded");
    render.put("output", "pdf");
    render.put("download_url", "https://cdn.formfeed.test/o/x.pdf?exp=1&sig=2");
    render.put("expires_at", "2026-12-18T10:00:00Z");
    render.put("bytes", 5681);
    render.put("page_count", 1);
    render.put("units", 1);
    render.put("region", "eu");
    render.put("environment", "test");
    render.put("template", Map.of("id", "tpl_1", "slug", "invoice", "version", 3));
    render.put("meta", Map.of());
    render.put("created_at", "2026-11-18T10:00:00Z");
    render.put("completed_at", "2026-11-18T10:00:01Z");
    return render;
  }

  /** The package's folder, which the tests read the shared fixtures beside. */
  static Path packageDir() {
    return Path.of(System.getProperty("formfeed.package", ".")).toAbsolutePath().normalize();
  }

  /** A stub API that answers with {@code responder}, closed after the test. */
  StubApi stub(StubApi.Responder responder) {
    StubApi api = new StubApi(responder);
    stubs.add(api);
    return api;
  }

  /** A client of the stub that records its waits instead of sleeping. */
  Formfeed client(StubApi api) {
    return client(api, 3, 0.5);
  }

  Formfeed client(StubApi api, int maxRetries, double jitter) {
    waits.clear();
    return Formfeed.builder()
        .apiKey("ff_test_k")
        .baseUrl(api.baseUrl())
        .maxRetries(maxRetries)
        .sleeper(waits::add)
        .jitter(() -> jitter)
        .build();
  }

  @AfterEach
  void closeStubs() {
    stubs.forEach(StubApi::close);
    stubs.clear();
  }

  static Map<String, Object> body(StubApi.Seen request) {
    try {
      return StubApi.JSON.readValue(request.body, new TypeReference<Map<String, Object>>() {});
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  static Map<String, Object> json(Path file) {
    try {
      return StubApi.JSON.readValue(file.toFile(), new TypeReference<Map<String, Object>>() {});
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /**
   * The fields of a multipart request, the file under {@code file} as [filename, content type,
   * bytes as ISO-8859-1 text].
   */
  static Map<String, Object> parts(StubApi.Seen request) {
    String type = request.header("Content-Type");
    assertTrue(
        type != null && type.startsWith("multipart/form-data; boundary="), "a multipart request");
    String boundary = type.substring("multipart/form-data; boundary=".length());
    String body = new String(request.body, StandardCharsets.ISO_8859_1);
    Map<String, Object> parts = new LinkedHashMap<>();
    Pattern name = Pattern.compile("name=\"([^\"]*)\"");
    Pattern file = Pattern.compile("filename=\"([^\"]*)\"");
    Pattern contentType = Pattern.compile("Content-Type: (.*)");
    for (String chunk : body.split(Pattern.quote("--" + boundary), -1)) {
      int split = chunk.indexOf("\r\n\r\n");
      if (split < 0) {
        continue;
      }
      String head = chunk.substring(0, split).replaceFirst("^\r\n", "");
      String content = chunk.substring(split + 4, chunk.length() - 2);
      Matcher named = name.matcher(head);
      if (!named.find()) {
        continue;
      }
      Matcher filename = file.matcher(head);
      if (filename.find()) {
        Matcher typed = contentType.matcher(head);
        parts.put(
            named.group(1),
            List.of(filename.group(1), typed.find() ? typed.group(1).trim() : "", content));
      } else {
        parts.put(
            named.group(1),
            new String(content.getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8));
      }
    }
    return parts;
  }

  static long millis(Duration duration) {
    return duration.toMillis();
  }
}
