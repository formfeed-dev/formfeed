package dev.formfeed;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

final class Ids {
  private static final char[] HEX = "0123456789ABCDEF".toCharArray();

  private Ids() {}

  /**
   * A fresh Idempotency-Key: every call that creates a render sends one, so a retry cannot charge
   * twice.
   */
  static String key() {
    return UUID.randomUUID().toString();
  }

  /** The key the caller gave, else a fresh one. */
  static String keyOr(String given) {
    return given == null ? key() : given;
  }

  /** One path segment, percent-encoded. */
  static String segment(String value) {
    return encode(value);
  }

  /** RFC 3986: every byte of the UTF-8 text but the unreserved characters is percent-encoded. */
  static String encode(String value) {
    StringBuilder out = new StringBuilder();
    for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
      int c = b & 0xFF;
      if ((c >= 'a' && c <= 'z')
          || (c >= 'A' && c <= 'Z')
          || (c >= '0' && c <= '9')
          || c == '-'
          || c == '.'
          || c == '_'
          || c == '~') {
        out.append((char) c);
      } else {
        out.append('%').append(HEX[c >> 4]).append(HEX[c & 0xF]);
      }
    }
    return out.toString();
  }

  /** The id of a source given as a render, a library file or a string (an id or a file's name). */
  static String of(Object source, String what) {
    if (source instanceof String) {
      return (String) source;
    }
    if (source instanceof Render) {
      return ((Render) source).getId();
    }
    if (source instanceof LibraryFile) {
      return ((LibraryFile) source).getId();
    }
    if (source instanceof Job) {
      return ((Job) source).getId();
    }
    throw new IllegalArgumentException(
        what
            + " takes a render, a library file or its id, not "
            + (source == null ? "null" : source.getClass().getSimpleName()));
  }
}
