package dev.formfeed;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The API on the JDK's own HTTP server: answers from a function and keeps every request it was
 * sent, so a test sees the bytes a client puts on the wire.
 */
final class StubApi implements AutoCloseable {
  static final ObjectMapper JSON = new ObjectMapper();

  /** A request as it arrived. */
  static final class Seen {
    final String method;
    final String target;
    final Map<String, List<String>> headers;
    final byte[] body;

    Seen(String method, String target, Map<String, List<String>> headers, byte[] body) {
      this.method = method;
      this.target = target;
      this.headers = headers;
      this.body = body;
    }

    /** The header's first value, null when it was not sent. */
    String header(String name) {
      List<String> values = headers.get(name);
      return values == null || values.isEmpty() ? null : values.get(0);
    }

    String text() {
      return new String(body, StandardCharsets.UTF_8);
    }
  }

  /** What the stub answers. */
  static final class Answer {
    final int status;
    final Map<String, String> headers;
    final byte[] body;
    final boolean broken;

    private Answer(int status, Map<String, String> headers, byte[] body, boolean broken) {
      this.status = status;
      this.headers = headers;
      this.body = body;
      this.broken = broken;
    }

    /** A JSON answer; {@code headers} are name, value, name, value, … */
    static Answer json(Object body, int status, String... headers) {
      try {
        Map<String, String> all = pairs(headers);
        all.putIfAbsent("Content-Type", "application/json");
        return new Answer(status, all, JSON.writeValueAsBytes(body), false);
      } catch (JsonProcessingException e) {
        throw new IllegalArgumentException(e);
      }
    }

    static Answer json(Object body) {
      return json(body, 200);
    }

    static Answer bytes(int status, byte[] body, String... headers) {
      return new Answer(status, pairs(headers), body, false);
    }

    static Answer empty(int status, String... headers) {
      return new Answer(status, pairs(headers), new byte[0], false);
    }

    /** The connection breaks in the middle of the answer: a network error on the client's side. */
    static Answer broken() {
      return new Answer(200, Map.of(), new byte[0], true);
    }

    private static Map<String, String> pairs(String... headers) {
      Map<String, String> out = new LinkedHashMap<>();
      for (int i = 0; i + 1 < headers.length; i += 2) {
        out.put(headers[i], headers[i + 1]);
      }
      return out;
    }
  }

  @FunctionalInterface
  interface Responder {
    /** The answer to request number {@code n}, from 1. */
    Answer answer(Seen request, int n) throws Exception;
  }

  private final HttpServer server;
  private final ExecutorService executor;
  private final List<Seen> requests = Collections.synchronizedList(new ArrayList<>());

  StubApi(Responder responder) {
    try {
      server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    executor =
        Executors.newCachedThreadPool(task -> {
          Thread thread = new Thread(task, "stub-api");
          thread.setDaemon(true);
          return thread;
        });
    server.setExecutor(executor);
    server.createContext("/", exchange -> handle(exchange, responder));
    server.start();
  }

  private void handle(HttpExchange exchange, Responder responder) {
    try {
      respond(exchange, responder);
    } catch (IOException e) {
      // a broken answer ends here, as it should
    } finally {
      exchange.close();
    }
  }

  private void respond(HttpExchange exchange, Responder responder) throws IOException {
    byte[] body = exchange.getRequestBody().readAllBytes();
    Map<String, List<String>> headers = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
    exchange.getRequestHeaders().forEach((name, values) -> headers.put(name, List.copyOf(values)));
    String query = exchange.getRequestURI().getRawQuery();
    Seen seen =
        new Seen(
            exchange.getRequestMethod(),
            exchange.getRequestURI().getRawPath() + (query == null ? "" : "?" + query),
            Collections.unmodifiableMap(headers),
            body);
    int n;
    synchronized (requests) {
      requests.add(seen);
      n = requests.size();
    }
    Answer answer;
    try {
      answer = responder.answer(seen, n);
    } catch (Exception e) {
      answer = Answer.json(Map.of("code", "stub_failed", "detail", String.valueOf(e)), 599);
    }
    if (answer.broken) {
      // promise a body and close the connection after a byte of it
      exchange.sendResponseHeaders(200, 64);
      OutputStream out = exchange.getResponseBody();
      out.write('{');
      out.flush();
      return;
    }
    answer.headers.forEach((name, value) -> exchange.getResponseHeaders().add(name, value));
    exchange.sendResponseHeaders(answer.status, answer.body.length == 0 ? -1 : answer.body.length);
    if (answer.body.length > 0) {
      try (OutputStream out = exchange.getResponseBody()) {
        out.write(answer.body);
      }
    }
  }

  /** {@code http://127.0.0.1:<port>}. */
  String url() {
    return "http://" + server.getAddress().getHostString() + ":" + server.getAddress().getPort();
  }

  /** The base URL a client is given: {@link #url()} with {@code /v1}. */
  String baseUrl() {
    return url() + "/v1";
  }

  List<Seen> requests() {
    synchronized (requests) {
      return List.copyOf(requests);
    }
  }

  Seen request(int index) {
    List<Seen> all = requests();
    if (index >= all.size()) {
      throw new IndexOutOfBoundsException("no request " + index + " of " + all.size());
    }
    return all.get(index);
  }

  @Override
  public void close() {
    server.stop(0);
    executor.shutdownNow();
  }
}
