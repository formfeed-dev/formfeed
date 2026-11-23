package dev.formfeed;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Checks a webhook delivery: {@code Webhook-Signature: t=<unix>,v1=<hex>}, the HMAC-SHA256 of
 * {@code <t>.<raw body>} with the endpoint's secret, at most 300 seconds either way, compared in
 * constant time. Pass the body exactly as it arrived: the signature covers the bytes on the wire,
 * so read it as bytes or as the text it was, never as JSON written again.
 *
 * <pre>{@code
 * WebhookEvent event = Webhook.parse(secret, request.getHeader("Webhook-Signature"), body);
 * }</pre>
 */
public final class Webhook {
  /** How old, or how far ahead, a delivery's timestamp may be: five minutes. */
  public static final long DEFAULT_TOLERANCE_SECONDS = 300;

  private static final Pattern DIGITS = Pattern.compile("[0-9]+");
  private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");
  private static final char[] HEX = "0123456789abcdef".toCharArray();

  private Webhook() {}

  /** Whether the signature matches the body and is at most five minutes old. */
  public static boolean verify(String secret, String signatureHeader, String rawBody) {
    return verify(secret, signatureHeader, utf8(rawBody));
  }

  /** Whether the signature matches the body and is at most five minutes old. */
  public static boolean verify(String secret, String signatureHeader, byte[] rawBody) {
    return verify(
        secret,
        signatureHeader,
        rawBody,
        DEFAULT_TOLERANCE_SECONDS,
        System.currentTimeMillis() / 1000);
  }

  /**
   * Whether the signature matches the body, with a tolerance and a clock of your own.
   *
   * @param toleranceSeconds how far the timestamp may lie from {@code nowEpochSeconds}, either way
   * @param nowEpochSeconds the current time in Unix seconds
   */
  public static boolean verify(
      String secret,
      String signatureHeader,
      String rawBody,
      long toleranceSeconds,
      long nowEpochSeconds) {
    return verify(secret, signatureHeader, utf8(rawBody), toleranceSeconds, nowEpochSeconds);
  }

  /**
   * Whether the signature matches the body, with a tolerance and a clock of your own.
   *
   * @param toleranceSeconds how far the timestamp may lie from {@code nowEpochSeconds}, either way
   * @param nowEpochSeconds the current time in Unix seconds
   */
  public static boolean verify(
      String secret,
      String signatureHeader,
      byte[] rawBody,
      long toleranceSeconds,
      long nowEpochSeconds) {
    if (signatureHeader == null
        || signatureHeader.isEmpty()
        || secret == null
        || secret.isEmpty()
        || rawBody == null) {
      return false;
    }
    Map<String, String> parts = new HashMap<>();
    for (String pair : signatureHeader.split(",", -1)) {
      String trimmed = pair.trim();
      int equals = trimmed.indexOf('=');
      String key = equals < 0 ? trimmed : trimmed.substring(0, equals);
      String value = equals < 0 ? "" : trimmed.substring(equals + 1);
      parts.put(key.trim(), value.trim());
    }
    String t = parts.getOrDefault("t", "");
    String v1 = parts.getOrDefault("v1", "").toLowerCase(Locale.ROOT);
    if (!DIGITS.matcher(t).matches() || !HEX64.matcher(v1).matches()) {
      return false;
    }
    long time;
    try {
      time = Long.parseLong(t);
    } catch (NumberFormatException e) {
      return false;
    }
    if (Math.abs(nowEpochSeconds - time) > toleranceSeconds) {
      return false;
    }
    byte[] expected = hmac(secret, time, rawBody);
    return MessageDigest.isEqual(expected, v1.getBytes(StandardCharsets.US_ASCII));
  }

  /**
   * The event of a verified delivery.
   *
   * @throws IllegalArgumentException when the signature does not match or the body is not a JSON
   *     object
   */
  public static WebhookEvent parse(String secret, String signatureHeader, String rawBody) {
    return parse(secret, signatureHeader, utf8(rawBody));
  }

  /**
   * The event of a verified delivery.
   *
   * @throws IllegalArgumentException when the signature does not match or the body is not a JSON
   *     object
   */
  public static WebhookEvent parse(String secret, String signatureHeader, byte[] rawBody) {
    return parse(
        secret,
        signatureHeader,
        rawBody,
        DEFAULT_TOLERANCE_SECONDS,
        System.currentTimeMillis() / 1000);
  }

  /**
   * The event of a verified delivery, with a tolerance and a clock of your own.
   *
   * @throws IllegalArgumentException when the signature does not match or the body is not a JSON
   *     object
   */
  public static WebhookEvent parse(
      String secret,
      String signatureHeader,
      String rawBody,
      long toleranceSeconds,
      long nowEpochSeconds) {
    return parse(secret, signatureHeader, utf8(rawBody), toleranceSeconds, nowEpochSeconds);
  }

  /**
   * The event of a verified delivery, with a tolerance and a clock of your own.
   *
   * @throws IllegalArgumentException when the signature does not match or the body is not a JSON
   *     object
   */
  public static WebhookEvent parse(
      String secret,
      String signatureHeader,
      byte[] rawBody,
      long toleranceSeconds,
      long nowEpochSeconds) {
    if (!verify(secret, signatureHeader, rawBody, toleranceSeconds, nowEpochSeconds)) {
      throw new IllegalArgumentException("invalid webhook signature");
    }
    Object event;
    try {
      event = Json.DEFAULT.decode(rawBody);
    } catch (IOException e) {
      throw new IllegalArgumentException("the webhook body is not JSON", e);
    }
    if (!(event instanceof Map)) {
      throw new IllegalArgumentException("the webhook body is not a JSON object");
    }
    return WebhookEvent.fromMap(Fields.object((Map<?, ?>) event));
  }

  private static byte[] hmac(String secret, long time, byte[] body) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(utf8(secret), "HmacSHA256"));
      mac.update(utf8(time + "."));
      byte[] digest = mac.doFinal(body);
      char[] hex = new char[digest.length * 2];
      for (int i = 0; i < digest.length; i++) {
        hex[i * 2] = HEX[(digest[i] >> 4) & 0xF];
        hex[i * 2 + 1] = HEX[digest[i] & 0xF];
      }
      return new String(hex).getBytes(StandardCharsets.US_ASCII);
    } catch (NoSuchAlgorithmException | InvalidKeyException e) {
      // every Java runtime has HmacSHA256, and any key bytes make a valid HMAC key
      throw new IllegalStateException("HmacSHA256 is not available", e);
    }
  }

  private static byte[] utf8(String text) {
    return text == null ? null : text.getBytes(StandardCharsets.UTF_8);
  }
}
