package dev.formfeed;

import java.time.Duration;

/**
 * How the client waits between retries and between the polls of {@code waitFor}. The default sleeps
 * the thread; tests pass one that records the waits instead.
 */
@FunctionalInterface
public interface Sleeper {
  /**
   * Waits for the duration.
   *
   * @param duration how long
   * @throws InterruptedException when the thread is interrupted, which ends the call with {@code
   *     interrupted}
   */
  void sleep(Duration duration) throws InterruptedException;
}
