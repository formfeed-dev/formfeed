package dev.formfeed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The test vectors every Formfeed SDK reads (plan 34, decision 9), written by {@code
 * packages/api-types/src/lib/sdk-fixtures.spec.ts}: webhook signatures, retries and problems,
 * played through the client as a caller meets them. They travel with the package to the public
 * repository, so a missing file fails here.
 */
final class VectorsTest extends ClientTestCase {
  private static Map<String, Object> vectors(String name) {
    return json(packageDir().resolve("../api-types/fixtures/sdk/" + name + ".json").normalize());
  }

  private static Stream<Arguments> cases(String name) {
    Object cases = vectors(name).get("cases");
    List<Arguments> out = new ArrayList<>();
    for (Object entry : (List<?>) cases) {
      Map<String, Object> vector = new LinkedHashMap<>();
      ((Map<?, ?>) entry).forEach((key, value) -> vector.put(String.valueOf(key), value));
      out.add(Arguments.of(vector.get("name"), vector));
    }
    return out.stream();
  }

  static Stream<Arguments> webhookCases() {
    return cases("webhook-signatures");
  }

  static Stream<Arguments> problemCases() {
    return cases("problems");
  }

  /** Every retry sequence twice: at the lowest jitter and at the highest. */
  static Stream<Arguments> retryCases() {
    return cases("retries")
        .flatMap(arguments ->
            Stream.of(0.0, 1.0)
                .map(jitter ->
                    Arguments.of(
                        arguments.get()[0] + " at jitter " + jitter, arguments.get()[1], jitter)));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("webhookCases")
  void webhookSignature(String name, Map<String, Object> vector) {
    Map<String, Object> vectors = vectors("webhook-signatures");
    String secret = (String) vectors.get("secret");
    long now = ((Number) vectors.get("now")).longValue();
    long tolerance = ((Number) vectors.get("tolerance_seconds")).longValue();
    String header = (String) vector.get("header");
    String body =
        vector.get("body") instanceof String
            ? (String) vector.get("body")
            : (String) vectors.get("body");
    boolean valid = (Boolean) vector.get("valid");

    assertEquals(valid, Webhook.verify(secret, header, body, tolerance, now), "as text");
    assertEquals(
        valid,
        Webhook.verify(secret, header, body.getBytes(StandardCharsets.UTF_8), tolerance, now),
        "as bytes");
    if (valid) {
      assertEquals("evt_1", Webhook.parse(secret, header, body, tolerance, now).getId());
    } else {
      assertThrows(
          IllegalArgumentException.class,
          () -> Webhook.parse(secret, header, body, tolerance, now));
    }
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("retryCases")
  void retries(String name, Map<String, Object> vector, double jitter) {
    List<?> answers = (List<?>) vector.get("answers");
    StubApi api =
        stub((request, n) -> {
          if (n > answers.size()) {
            throw new IllegalStateException("more requests than answers");
          }
          Map<?, ?> answer = (Map<?, ?>) answers.get(n - 1);
          if (Boolean.TRUE.equals(answer.get("network_error"))) {
            return StubApi.Answer.broken();
          }
          int status =
              answer.get("status") instanceof Number
                  ? ((Number) answer.get("status")).intValue()
                  : 200;
          Object body = answer.get("body") == null ? Map.of() : answer.get("body");
          return answer.get("retry_after") instanceof String
              ? StubApi.Answer.json(body, status, "Retry-After", (String) answer.get("retry_after"))
              : StubApi.Answer.json(body, status);
        });
    int maxRetries = ((Number) vectors("retries").get("max_retries")).intValue();
    Formfeed formfeed = client(api, maxRetries, jitter);

    Map<String, Object> outcome;
    try {
      formfeed.request("GET", "/account");
      outcome = Map.of("ok", true);
    } catch (FormfeedException e) {
      outcome = Map.of("error", Map.of("code", e.getCode(), "status", e.getStatus()));
    }

    assertEquals(vector.get("outcome"), outcome);
    assertEquals(answers.size(), api.requests().size(), "requests");
    List<?> bounds = (List<?>) vector.get("waits_ms");
    assertEquals(bounds.size(), waits.size(), "waits");
    for (int i = 0; i < waits.size(); i++) {
      List<?> range = (List<?>) bounds.get(i);
      double lowest = ((Number) range.get(0)).doubleValue();
      double highest = ((Number) range.get(1)).doubleValue();
      double waited = waits.get(i).toNanos() / 1_000_000.0;
      assertTrue(waited >= lowest && waited <= highest, "wait " + i + ": " + waited + " ms");
      assertEquals(jitter == 0.0 ? lowest : highest, waited, 1e-6, "wait " + i + " at its edge");
    }
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("problemCases")
  void problem(String name, Map<String, Object> vector) {
    int status = ((Number) vector.get("status")).intValue();
    List<String> headers = new ArrayList<>();
    ((Map<?, ?>) vector.get("headers"))
        .forEach((header, value) -> {
          headers.add(String.valueOf(header));
          headers.add(String.valueOf(value));
        });
    Object body = vector.get("body");
    StubApi api =
        stub((request, n) -> {
          if (body == null) {
            return StubApi.Answer.empty(status, headers.toArray(new String[0]));
          }
          if (body instanceof String) {
            headers.add("Content-Type");
            headers.add("text/plain");
            return StubApi.Answer.bytes(
                status,
                ((String) body).getBytes(StandardCharsets.UTF_8),
                headers.toArray(new String[0]));
          }
          return StubApi.Answer.json(body, status, headers.toArray(new String[0]));
        });
    Formfeed formfeed = client(api, 0, 0.0);

    FormfeedException e =
        assertThrows(FormfeedException.class, () -> formfeed.request("GET", "/account"));

    Map<String, Object> got = new LinkedHashMap<>();
    got.put("code", e.getCode());
    got.put("message", e.getMessage());
    got.put("status", e.getStatus());
    got.put("request_id", e.getRequestId());
    assertEquals(vector.get("expect"), got);
    assertTrue(waits.isEmpty(), "no retries");
  }
}
