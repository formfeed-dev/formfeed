package dev.formfeed;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * One page of a list, newest first, and the cursor of the next (null on the last). The {@code
 * all()} methods follow the cursor for you.
 *
 * @param <T> what the list holds
 */
public final class Page<T> {
  private final List<T> data;
  private final String nextCursor;

  private Page(List<T> data, String nextCursor) {
    this.data = data;
    this.nextCursor = nextCursor;
  }

  /** Reads a page, each entry with {@code item}, such as {@code Render::fromMap}. */
  public static <T> Page<T> fromMap(Map<String, ?> page, Function<Map<String, Object>, T> item) {
    Map<String, Object> members = Fields.object(page);
    List<T> data = new ArrayList<>();
    for (Map<String, Object> entry : Fields.objects(members, "data")) {
      data.add(item.apply(entry));
    }
    return new Page<>(
        Collections.unmodifiableList(data), Fields.stringOrNull(members, "next_cursor"));
  }

  public List<T> getData() {
    return data;
  }

  /** The {@code cursor} of the next page; null on the last. */
  public String getNextCursor() {
    return nextCursor;
  }

  /** Whether there is a page after this one. */
  public boolean hasMore() {
    return nextCursor != null;
  }

  @Override
  public String toString() {
    return "Page{data=" + data.size() + " entries, nextCursor=" + nextCursor + "}";
  }
}
