package dev.formfeed;

import java.util.Map;

/** The key's account: workspace, organisation, plan and usage. */
public final class Account {
  private final Transport transport;

  Account(Transport transport) {
    this.transport = transport;
  }

  /** The key's workspace and organisation, the plan with its limits, and the period's units. */
  public Map<String, Object> get() {
    return transport.object("GET", "/account");
  }

  /** Units of the current period, with a daily series and a breakdown per template. */
  public Usage usage() {
    return usage("current");
  }

  /** Units of the period that started in {@code YYYY-MM}, or of {@code current}. */
  public Usage usage(String period) {
    return Usage.fromMap(transport.object("GET", "/usage?period=" + Ids.encode(period)));
  }
}
