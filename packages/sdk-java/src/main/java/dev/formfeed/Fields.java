package dev.formfeed;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Typed reads of a decoded answer. A field the API leaves out, or sends with another type, reads as
 * its default, so an SDK of today reads the answers of a later API (the contract goldens hold
 * that).
 */
final class Fields {
  private Fields() {}

  /** A JSON object with string keys, copied and frozen all the way down. */
  static Map<String, Object> object(Map<?, ?> value) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (Map.Entry<?, ?> entry : value.entrySet()) {
      out.put(String.valueOf(entry.getKey()), freeze(entry.getValue()));
    }
    return Collections.unmodifiableMap(out);
  }

  /** A decoded JSON value with every map and list in it made unmodifiable. */
  static Object freeze(Object value) {
    if (value instanceof Map) {
      return object((Map<?, ?>) value);
    }
    if (value instanceof List) {
      List<Object> out = new ArrayList<>();
      for (Object item : (List<?>) value) {
        out.add(freeze(item));
      }
      return Collections.unmodifiableList(out);
    }
    return value;
  }

  static String string(Map<String, Object> from, String key) {
    Object value = from.get(key);
    if (value instanceof String) {
      return (String) value;
    }
    return value instanceof Number ? numberText((Number) value) : "";
  }

  static String stringOrNull(Map<String, Object> from, String key) {
    Object value = from.get(key);
    return value instanceof String ? (String) value : null;
  }

  static int integer(Map<String, Object> from, String key) {
    Object value = from.get(key);
    return value instanceof Number ? ((Number) value).intValue() : 0;
  }

  static Integer integerOrNull(Map<String, Object> from, String key) {
    Object value = from.get(key);
    return value instanceof Number ? ((Number) value).intValue() : null;
  }

  static Long longOrNull(Map<String, Object> from, String key) {
    Object value = from.get(key);
    return value instanceof Number ? ((Number) value).longValue() : null;
  }

  static long longValue(Map<String, Object> from, String key) {
    Long value = longOrNull(from, key);
    return value == null ? 0L : value;
  }

  static double number(Map<String, Object> from, String key) {
    Object value = from.get(key);
    return value instanceof Number ? ((Number) value).doubleValue() : 0.0;
  }

  static Double numberOrNull(Map<String, Object> from, String key) {
    Object value = from.get(key);
    return value instanceof Number ? ((Number) value).doubleValue() : null;
  }

  static boolean bool(Map<String, Object> from, String key, boolean fallback) {
    Object value = from.get(key);
    return value instanceof Boolean ? (Boolean) value : fallback;
  }

  static Map<String, Object> map(Map<String, Object> from, String key) {
    Map<String, Object> value = mapOrNull(from, key);
    return value == null ? Collections.emptyMap() : value;
  }

  static Map<String, Object> mapOrNull(Map<String, Object> from, String key) {
    Object value = from.get(key);
    return value instanceof Map ? object((Map<?, ?>) value) : null;
  }

  static List<String> strings(Map<String, Object> from, String key) {
    Object value = from.get(key);
    if (!(value instanceof List)) {
      return Collections.emptyList();
    }
    List<String> out = new ArrayList<>();
    for (Object item : (List<?>) value) {
      if (item instanceof String) {
        out.add((String) item);
      }
    }
    return Collections.unmodifiableList(out);
  }

  /** The entries of a list that are objects. */
  static List<Map<String, Object>> objects(Map<String, Object> from, String key) {
    Object value = from.get(key);
    if (!(value instanceof List)) {
      return Collections.emptyList();
    }
    List<Map<String, Object>> out = new ArrayList<>();
    for (Object item : (List<?>) value) {
      if (item instanceof Map) {
        out.add(object((Map<?, ?>) item));
      }
    }
    return Collections.unmodifiableList(out);
  }

  /** A number as text the way the other SDKs write it: 2.0 as {@code 2}, 1.5 as {@code 1.5}. */
  static String numberText(Number value) {
    if (value instanceof Double || value instanceof Float) {
      double d = value.doubleValue();
      if (Double.isNaN(d) || Double.isInfinite(d)) {
        return String.valueOf(d);
      }
      return BigDecimal.valueOf(d).stripTrailingZeros().toPlainString();
    }
    if (value instanceof BigDecimal) {
      return ((BigDecimal) value).stripTrailingZeros().toPlainString();
    }
    return value.toString();
  }
}
