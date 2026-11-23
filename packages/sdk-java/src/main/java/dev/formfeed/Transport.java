package dev.formfeed;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.function.DoubleSupplier;
import java.util.regex.Pattern;

/**
 * Auth, retries and problems, the rules every Formfeed SDK keeps (plan 34, decision 3): up to
 * {@code maxRetries} retries on 429, 503 and network errors, waiting a positive numeric {@code
 * Retry-After} in seconds, else 0.5 s doubling, plus up to 0.25 s of jitter, at most 30 s; a
 * problem becomes one {@link FormfeedException} with the code, the detail (else the title), the
 * status and {@code X-Request-Id}. {@code packages/api-types/fixtures/sdk} holds the cases, which
 * every SDK's tests play.
 */
final class Transport {
  static final String USER_AGENT = "formfeed-sdk-java/0.3";

  private static final Pattern NUMERIC =
      Pattern.compile("[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?");

  private final String apiKey;
  private final String baseUrl;
  private final HttpClient http;
  private final Duration timeout;
  private final int maxRetries;
  private final Map<String, String> headers;
  private final Sleeper sleeper;
  private final DoubleSupplier jitter;
  private final Json json;

  Transport(
      String apiKey,
      String baseUrl,
      HttpClient http,
      Duration timeout,
      int maxRetries,
      Map<String, String> headers,
      Sleeper sleeper,
      DoubleSupplier jitter,
      Json json) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.http = http;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.headers = headers;
    this.sleeper = sleeper;
    this.jitter = jitter;
    this.json = json;
  }

  String baseUrl() {
    return baseUrl;
  }

  Json json() {
    return json;
  }

  /** The decoded JSON answer, null for one without a body (204). */
  Object call(String method, String path, Object body, String idempotencyKey) {
    HttpResponse<byte[]> response = send(method, path, body, idempotencyKey);
    byte[] text = response.body();
    if (response.statusCode() == 204 || text == null || text.length == 0) {
      return null;
    }
    try {
      return Fields.freeze(json.decode(text));
    } catch (IOException e) {
      throw new FormfeedException(
          "invalid_response",
          String.format(
              "the API answered HTTP %d with a body that is not JSON", response.statusCode()),
          response.statusCode(),
          null,
          null,
          e);
    }
  }

  /** An answer that is a JSON object. */
  Map<String, Object> object(String method, String path, Object body, String idempotencyKey) {
    Object value = call(method, path, body, idempotencyKey);
    if (!(value instanceof Map)) {
      throw new FormfeedException(
          "invalid_response", "the API answered " + method + " " + path + " without a JSON object");
    }
    return Fields.object((Map<?, ?>) value);
  }

  Map<String, Object> object(String method, String path) {
    return object(method, path, null, null);
  }

  /** Waits, the way the client was told to. */
  void pause(Duration duration) {
    try {
      sleeper.sleep(duration);
    } catch (InterruptedException e) {
      throw interrupted(e);
    }
  }

  /** A signed link of the CDN as bytes, without the API key, which the link does not need. */
  byte[] download(String url) {
    HttpResponse<byte[]> response;
    try {
      response = http.send(plain(url), HttpResponse.BodyHandlers.ofByteArray());
    } catch (IOException e) {
      throw new FormfeedException("network_error", messageOf(e), 0, null, null, e);
    } catch (InterruptedException e) {
      throw interrupted(e);
    }
    if (response.statusCode() >= 400) {
      throw downloadFailed(response.statusCode());
    }
    return response.body();
  }

  /**
   * A signed link of the CDN streamed into a file: into a temporary file beside it first, moved
   * into place once complete, so a failed download leaves the path as it was. Answers the bytes
   * written.
   */
  long downloadTo(String url, Path path) {
    Path target = path.toAbsolutePath();
    Path directory = target.getParent();
    if (directory == null || !Files.isDirectory(directory)) {
      throw new UncheckedIOException(
          "cannot write " + path, new NoSuchFileException(String.valueOf(directory)));
    }
    // named here rather than by Files.createTempFile, which makes a file only its owner may read:
    // the download is created as any new file is, with the process's default permissions
    Path part = directory.resolve("." + target.getFileName() + "." + UUID.randomUUID() + ".part");
    boolean moved = false;
    try {
      HttpResponse<Path> response;
      try {
        response =
            http.send(
                plain(url),
                info ->
                    info.statusCode() >= 400
                        ? HttpResponse.BodySubscribers.<Path>replacing(null)
                        : HttpResponse.BodySubscribers.ofFile(
                            part, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE));
      } catch (IOException e) {
        throw new FormfeedException("network_error", messageOf(e), 0, null, null, e);
      } catch (InterruptedException e) {
        throw interrupted(e);
      }
      if (response.statusCode() >= 400) {
        throw downloadFailed(response.statusCode());
      }
      try {
        try {
          Files.move(
              part, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
          Files.move(part, target, StandardCopyOption.REPLACE_EXISTING);
        }
        moved = true;
        return Files.size(target);
      } catch (IOException e) {
        throw new UncheckedIOException("cannot write " + path, e);
      }
    } finally {
      if (!moved) {
        try {
          Files.deleteIfExists(part);
        } catch (IOException ignored) {
          // the temporary file stays; the download's own error says what went wrong
        }
      }
    }
  }

  /** The wait before retry number {@code attempt} (from 1), with the server's Retry-After. */
  Duration backoff(int attempt, String retryAfter) {
    return backoff(attempt, retryAfter, jitter.getAsDouble());
  }

  /**
   * The wait before retry number {@code attempt}: a positive numeric {@code Retry-After} in
   * seconds, else 500 ms doubling, plus {@code jitter} (0 to 1) of 250 ms, at most 30 s.
   */
  static Duration backoff(int attempt, String retryAfter, double jitter) {
    double base = 500 * Math.pow(2, attempt - 1);
    String header = retryAfter == null ? "" : retryAfter.trim();
    if (NUMERIC.matcher(header).matches()) {
      double seconds = Double.parseDouble(header);
      if (seconds > 0 && Double.isFinite(seconds)) {
        base = seconds * 1000;
      }
    }
    double share = Double.isNaN(jitter) ? 0 : Math.max(0, Math.min(1, jitter));
    double millis = Math.min(30_000, base + share * 250);
    return Duration.ofNanos(Math.round(millis * 1_000_000));
  }

  private HttpResponse<byte[]> send(
      String method, String path, Object body, String idempotencyKey) {
    URI uri = URI.create(baseUrl + path);
    HttpRequest.Builder builder =
        HttpRequest.newBuilder(uri)
            .timeout(timeout)
            .setHeader("Authorization", "Bearer " + apiKey)
            .setHeader("Accept", "application/json")
            .setHeader("User-Agent", USER_AGENT);
    if ("http".equalsIgnoreCase(uri.getScheme())) {
      // no h2c upgrade on plain HTTP (a local gateway); TLS negotiates HTTP/2 by itself
      builder.version(HttpClient.Version.HTTP_1_1);
    }
    for (Map.Entry<String, String> header : headers.entrySet()) {
      builder.setHeader(header.getKey(), header.getValue());
    }
    if (idempotencyKey != null) {
      builder.setHeader("Idempotency-Key", idempotencyKey);
    }
    if (body instanceof Multipart) {
      Multipart form = (Multipart) body;
      builder
          .setHeader("Content-Type", form.contentType())
          .method(method, HttpRequest.BodyPublishers.ofByteArray(form.body()));
    } else if (body != null) {
      builder
          .setHeader("Content-Type", "application/json")
          .method(method, HttpRequest.BodyPublishers.ofByteArray(json.encode(body)));
    } else {
      builder.method(method, HttpRequest.BodyPublishers.noBody());
    }
    // one request for every attempt: a retry sends the same bytes and the same Idempotency-Key
    HttpRequest request = builder.build();

    for (int attempt = 0; ; attempt++) {
      HttpResponse<byte[]> response;
      try {
        response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
      } catch (IOException e) {
        if (attempt < maxRetries) {
          pause(backoff(attempt + 1, null));
          continue;
        }
        throw new FormfeedException("network_error", messageOf(e), 0, null, null, e);
      } catch (InterruptedException e) {
        throw interrupted(e);
      }

      int status = response.statusCode();
      if ((status == 429 || status == 503) && attempt < maxRetries) {
        pause(backoff(attempt + 1, response.headers().firstValue("Retry-After").orElse(null)));
        continue;
      }
      if (status >= 400) {
        throw problem(response);
      }
      return response;
    }
  }

  private FormfeedException problem(HttpResponse<byte[]> response) {
    int status = response.statusCode();
    Map<String, Object> problem = null;
    byte[] text = response.body();
    if (text != null && text.length > 0) {
      try {
        Object decoded = json.decode(text);
        if (decoded instanceof Map) {
          problem = Fields.object((Map<?, ?>) decoded);
        }
      } catch (IOException e) {
        // a body that is not JSON, such as a proxy's page: the status speaks for it
      }
    }
    Map<String, Object> members = problem == null ? Map.of() : problem;
    String code = Fields.stringOrNull(members, "code");
    String detail = Fields.stringOrNull(members, "detail");
    String title = Fields.stringOrNull(members, "title");
    String requestId =
        response.headers().firstValue("X-Request-Id").filter(id -> !id.isEmpty()).orElse(null);
    return new FormfeedException(
        code != null && !code.isEmpty() ? code : "http_" + status,
        detail != null && !detail.isEmpty()
            ? detail
            : title != null && !title.isEmpty() ? title : "HTTP " + status,
        status,
        problem == null || problem.isEmpty() ? null : Problem.fromMap(problem),
        requestId,
        null);
  }

  private HttpRequest plain(String url) {
    URI uri = URI.create(url);
    HttpRequest.Builder builder = HttpRequest.newBuilder(uri).timeout(timeout).GET();
    if ("http".equalsIgnoreCase(uri.getScheme())) {
      builder.version(HttpClient.Version.HTTP_1_1);
    }
    return builder.build();
  }

  private static FormfeedException downloadFailed(int status) {
    return new FormfeedException(
        "download_failed", "download answered HTTP " + status, status, null, null, null);
  }

  private static FormfeedException interrupted(InterruptedException e) {
    Thread.currentThread().interrupt();
    return new FormfeedException("interrupted", "the call was interrupted", 0, null, null, e);
  }

  private static String messageOf(IOException e) {
    String message = e.getMessage();
    return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
  }
}
