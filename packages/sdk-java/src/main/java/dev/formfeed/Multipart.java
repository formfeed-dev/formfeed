package dev.formfeed;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A multipart body the way the API reads it: the file as {@code file}, strings as they are,
 * booleans and numbers as text, maps and lists as JSON text. Null fields are left out, as a form
 * field cannot say null, but for redact's {@code fill}, whose null draws no box and goes as the
 * JSON text {@code null}.
 */
final class Multipart {
  private static final SecureRandom RANDOM = new SecureRandom();

  private final String boundary;
  private final Map<String, String> fields;
  private final Upload file;

  Multipart(Map<String, ?> fields, Upload file, Json json) {
    byte[] random = new byte[12];
    RANDOM.nextBytes(random);
    StringBuilder hex = new StringBuilder("formfeed-");
    for (byte b : random) {
      hex.append(String.format("%02x", b & 0xFF));
    }
    this.boundary = hex.toString();
    this.file = file;
    Map<String, String> text = new LinkedHashMap<>();
    for (Map.Entry<String, ?> entry : fields.entrySet()) {
      Object value = entry.getValue();
      String name = entry.getKey();
      if (value == null && !"fill".equals(name)) {
        continue;
      }
      if (value instanceof String) {
        text.put(name, (String) value);
      } else if (value instanceof Boolean) {
        text.put(name, (Boolean) value ? "true" : "false");
      } else if (value instanceof Number) {
        text.put(name, Fields.numberText((Number) value));
      } else {
        text.put(name, new String(json.encode(value), StandardCharsets.UTF_8));
      }
    }
    this.fields = Collections.unmodifiableMap(text);
  }

  String contentType() {
    return "multipart/form-data; boundary=" + boundary;
  }

  byte[] body() {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    if (file != null) {
      write(
          out,
          "--"
              + boundary
              + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\""
              + quoted(file.getName())
              + "\"\r\nContent-Type: "
              + file.getContentType()
              + "\r\n\r\n");
      byte[] contents = file.contents();
      out.write(contents, 0, contents.length);
      write(out, "\r\n");
    }
    for (Map.Entry<String, String> field : fields.entrySet()) {
      write(
          out,
          "--"
              + boundary
              + "\r\nContent-Disposition: form-data; name=\""
              + quoted(field.getKey())
              + "\"\r\n\r\n"
              + field.getValue()
              + "\r\n");
    }
    write(out, "--" + boundary + "--\r\n");
    return out.toByteArray();
  }

  /** The fields as they are sent, for tests. */
  Map<String, String> fields() {
    return fields;
  }

  private static void write(ByteArrayOutputStream out, String text) {
    byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
    out.write(bytes, 0, bytes.length);
  }

  private static String quoted(String value) {
    return value.replace("\"", "%22").replace("\r", "").replace("\n", "");
  }
}
