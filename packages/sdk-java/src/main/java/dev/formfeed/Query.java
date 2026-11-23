package dev.formfeed;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

final class Query {
  private Query() {}

  /**
   * {@code ?a=1&b=2} of the values that are set, or an empty string; booleans as {@code true} and
   * {@code false}, anything that is not text, a number or a boolean left out.
   */
  static String string(Map<String, ?> query) {
    List<String> pairs = new ArrayList<>();
    for (Map.Entry<String, ?> entry : query.entrySet()) {
      Object value = entry.getValue();
      String text;
      if (value instanceof String || value instanceof Character) {
        text = value.toString();
      } else if (value instanceof Boolean) {
        text = (Boolean) value ? "true" : "false";
      } else if (value instanceof Number) {
        text = Fields.numberText((Number) value);
      } else {
        continue;
      }
      if (text.isEmpty()) {
        continue;
      }
      pairs.add(Ids.encode(entry.getKey()) + "=" + Ids.encode(text));
    }
    return pairs.isEmpty() ? "" : "?" + String.join("&", pairs);
  }
}
