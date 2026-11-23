package dev.formfeed;

import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.function.Function;

final class Paging {
  private Paging() {}

  /**
   * Every entry the query matches, page by page as the iteration reaches it. Each {@code
   * iterator()} starts again at the first page.
   */
  static <T> Iterable<T> all(Map<String, ?> query, Function<Map<String, Object>, Page<T>> list) {
    Map<String, Object> base = new LinkedHashMap<>(query);
    return () ->
        new Iterator<T>() {
          private Iterator<T> current = Collections.emptyIterator();
          private String cursor;
          private boolean started;

          @Override
          public boolean hasNext() {
            while (!current.hasNext()) {
              if (started && cursor == null) {
                return false;
              }
              Map<String, Object> next = new LinkedHashMap<>(base);
              next.put("cursor", cursor);
              Page<T> page = list.apply(next);
              started = true;
              cursor = page.getNextCursor();
              current = page.getData().iterator();
            }
            return true;
          }

          @Override
          public T next() {
            if (!hasNext()) {
              throw new NoSuchElementException();
            }
            return current.next();
          }
        };
  }
}
