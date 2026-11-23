package dev.formfeed;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Collections;
import java.util.Map;

/** Renders: create, read, list, wait for and download them, and queue batches. */
public final class Renders {
  private static final Duration WAIT = Duration.ofSeconds(120);
  private static final Duration POLL = Duration.ofSeconds(1);

  private final Transport transport;

  Renders(Transport transport) {
    this.transport = transport;
  }

  /**
   * Renders a template, HTML, a URL or Markdown. Sync by default, so the answer is the finished
   * render; {@code mode("async")} answers it queued. A retry of the same call sends the same
   * Idempotency-Key, generated here, so it cannot charge twice.
   */
  public Render create(RenderRequest request) {
    return create(request.toMap(), null);
  }

  /** {@link #create(RenderRequest)} with your own Idempotency-Key, such as your order's number. */
  public Render create(RenderRequest request, String idempotencyKey) {
    return create(request.toMap(), idempotencyKey);
  }

  /**
   * Renders the request as a map: {@code template} with {@code data}, or {@code html}, {@code url}
   * or {@code markdown}; {@code output}, {@code settings}, …
   */
  public Render create(Map<String, ?> request) {
    return create(request, null);
  }

  /** {@link #create(Map)} with your own Idempotency-Key; null generates one. */
  public Render create(Map<String, ?> request, String idempotencyKey) {
    return Render.fromMap(transport.object("POST", "/renders", request, Ids.keyOr(idempotencyKey)));
  }

  public Render get(String id) {
    return Render.fromMap(transport.object("GET", "/renders/" + Ids.segment(id)));
  }

  /** The render again, as it is now. */
  public Render get(Render render) {
    return get(render.getId());
  }

  /** The first page of renders, newest first. */
  public Page<Render> list() {
    return list(Collections.emptyMap());
  }

  /**
   * One page of renders, newest first.
   *
   * @param query {@code template}, {@code status}, {@code environment}, {@code since}, {@code
   *     until}, {@code limit}, {@code cursor}
   */
  public Page<Render> list(Map<String, ?> query) {
    return Page.fromMap(transport.object("GET", "/renders" + Query.string(query)), Render::fromMap);
  }

  /** Every render, page by page as you iterate. */
  public Iterable<Render> all() {
    return all(Collections.emptyMap());
  }

  /** Every render the query matches, page by page as you iterate. */
  public Iterable<Render> all(Map<String, ?> query) {
    return Paging.all(query, this::list);
  }

  /**
   * Removes the stored files of a render before they expire. Needs the {@code file:delete} scope.
   */
  public void deleteOutputs(String id) {
    transport.call("DELETE", "/renders/" + Ids.segment(id) + "/outputs", null, null);
  }

  /** Removes the stored files of a render before they expire. */
  public void deleteOutputs(Render render) {
    deleteOutputs(render.getId());
  }

  /**
   * The stored request of a render, to render it again. Needs {@code render:input}; answers {@code
   * render_input_expired} (410) when the workspace keeps no requests or the period ended.
   */
  public RenderInput input(String id) {
    return RenderInput.fromMap(transport.object("GET", "/renders/" + Ids.segment(id) + "/input"));
  }

  /** The stored request of a render. */
  public RenderInput input(Render render) {
    return input(render.getId());
  }

  /**
   * Queues many renders as one job; its renders keep the order of {@code items}.
   *
   * @param request {@code items}, and {@code template}, {@code output}, {@code settings} shared by
   *     them
   */
  public Job batch(Map<String, ?> request) {
    return batch(request, null);
  }

  /** {@link #batch(Map)} with your own Idempotency-Key; null generates one. */
  public Job batch(Map<String, ?> request, String idempotencyKey) {
    return Job.fromMap(
        transport.object("POST", "/renders/batch", request, Ids.keyOr(idempotencyKey)));
  }

  /** Polls every second until the render succeeded or failed, at most two minutes. */
  public Render waitFor(String id) {
    return waitFor(id, WAIT, POLL);
  }

  /** Polls every second until the render succeeded or failed, at most two minutes. */
  public Render waitFor(Render render) {
    return waitFor(render.getId(), WAIT, POLL);
  }

  /** Polls until the render succeeded or failed (an async one), at most {@code timeout}. */
  public Render waitFor(Render render, Duration timeout, Duration interval) {
    return waitFor(render.getId(), timeout, interval);
  }

  /**
   * Polls until the render succeeded or failed (an async one), at most {@code timeout}.
   *
   * @throws FormfeedException {@code timeout} when it has not finished by then
   */
  public Render waitFor(String id, Duration timeout, Duration interval) {
    long started = System.nanoTime();
    Duration waited = Duration.ZERO;
    while (true) {
      Render current = get(id);
      if (current.isFinished()) {
        return current;
      }
      Duration elapsed = Duration.ofNanos(System.nanoTime() - started);
      Duration spent = elapsed.compareTo(waited) > 0 ? elapsed : waited;
      if (spent.plus(interval).compareTo(timeout) > 0) {
        throw new FormfeedException(
            "timeout", "render " + id + " did not finish within the wait time");
      }
      transport.pause(interval);
      waited = waited.plus(interval);
    }
  }

  /** The output of a finished render, as bytes. */
  public byte[] download(String id) {
    return download(get(id));
  }

  /**
   * The output of a finished render, as bytes.
   *
   * @throws FormfeedException {@code not_ready} when the render has no output (yet)
   */
  public byte[] download(Render render) {
    return transport.download(urlOf(render));
  }

  /** Writes the output of a finished render to a file; answers the bytes written. */
  public long downloadTo(String id, Path path) {
    return downloadTo(get(id), path);
  }

  /**
   * Writes the output of a finished render to a file, streamed, replacing the file only once the
   * download is complete; answers the bytes written.
   */
  public long downloadTo(Render render, Path path) {
    return transport.downloadTo(urlOf(render), path);
  }

  private static String urlOf(Render render) {
    if (render.getDownloadUrl() == null) {
      throw new FormfeedException(
          "not_ready", "render " + render.getId() + " has no output (" + render.getStatus() + ")");
    }
    return render.getDownloadUrl();
  }
}
