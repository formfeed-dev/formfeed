package dev.formfeed;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectReader;
import java.io.IOException;

/**
 * JSON through Jackson: requests written from maps, lists and your own objects, answers read as
 * plain maps and lists.
 */
final class Json {
  static final Json DEFAULT = new Json(new ObjectMapper());

  private final ObjectMapper mapper;
  private final ObjectReader reader;

  Json(ObjectMapper mapper) {
    this.mapper = mapper;
    this.reader =
        mapper.readerFor(Object.class).with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
  }

  byte[] encode(Object value) {
    try {
      return mapper.writeValueAsBytes(value);
    } catch (JsonProcessingException e) {
      throw new IllegalArgumentException(
          "the request cannot be written as JSON: " + e.getOriginalMessage(), e);
    }
  }

  /** The value of a JSON text: a map, a list, a string, a number, a boolean or null. */
  Object decode(byte[] text) throws IOException {
    return reader.readValue(text);
  }
}
