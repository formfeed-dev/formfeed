package dev.formfeed;

import java.time.Duration;

/** Jobs: batches, and renders queued with their own webhook URL. */
public final class Jobs {
  private static final Duration WAIT = Duration.ofMinutes(10);
  private static final Duration POLL = Duration.ofSeconds(2);

  private final Transport transport;

  Jobs(Transport transport) {
    this.transport = transport;
  }

  public Job get(String id) {
    return Job.fromMap(transport.object("GET", "/jobs/" + Ids.segment(id)));
  }

  /** The job again, as it is now. */
  public Job get(Job job) {
    return get(job.getId());
  }

  /**
   * Polls every two seconds until no render of the job is queued or running, at most ten minutes.
   */
  public Job waitFor(String id) {
    return waitFor(id, WAIT, POLL);
  }

  /**
   * Polls every two seconds until no render of the job is queued or running, at most ten minutes.
   */
  public Job waitFor(Job job) {
    return waitFor(job.getId(), WAIT, POLL);
  }

  /** Polls until no render of the job is queued or running, at most {@code timeout}. */
  public Job waitFor(Job job, Duration timeout, Duration interval) {
    return waitFor(job.getId(), timeout, interval);
  }

  /**
   * Polls until no render of the job is queued or running, at most {@code timeout}.
   *
   * @throws FormfeedException {@code timeout} when it has not finished by then
   */
  public Job waitFor(String id, Duration timeout, Duration interval) {
    long started = System.nanoTime();
    Duration waited = Duration.ZERO;
    while (true) {
      Job current = get(id);
      if (current.isFinished()) {
        return current;
      }
      Duration elapsed = Duration.ofNanos(System.nanoTime() - started);
      Duration spent = elapsed.compareTo(waited) > 0 ? elapsed : waited;
      if (spent.plus(interval).compareTo(timeout) > 0) {
        throw new FormfeedException(
            "timeout", "job " + id + " did not finish within the wait time");
      }
      transport.pause(interval);
      waited = waited.plus(interval);
    }
  }
}
