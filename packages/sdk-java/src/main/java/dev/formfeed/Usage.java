package dev.formfeed;

import java.util.List;
import java.util.Map;

/** The units of a billing period, with a daily series and a breakdown per template. */
public final class Usage {
  private final String period;
  private final String periodStart;
  private final String periodEnd;
  private final double included;
  private final double used;
  private final double overageUsed;
  private final double overageBalance;
  private final Double hardCapUnits;
  private final List<Map<String, Object>> daily;
  private final List<Map<String, Object>> byTemplate;
  private final Map<String, Object> raw;

  private Usage(Map<String, Object> data) {
    this.period = Fields.string(data, "period");
    this.periodStart = Fields.string(data, "period_start");
    this.periodEnd = Fields.string(data, "period_end");
    this.included = Fields.number(data, "included");
    this.used = Fields.number(data, "used");
    this.overageUsed = Fields.number(data, "overage_used");
    this.overageBalance = Fields.number(data, "overage_balance");
    this.hardCapUnits = Fields.numberOrNull(data, "hard_cap_units");
    this.daily = Fields.objects(data, "daily");
    this.byTemplate = Fields.objects(data, "by_template");
    this.raw = data;
  }

  /** Reads usage as the API answers it. */
  public static Usage fromMap(Map<String, ?> data) {
    return new Usage(Fields.object(data));
  }

  /** The month the period started in, {@code YYYY-MM}. */
  public String getPeriod() {
    return period;
  }

  /** The first day of the period, {@code YYYY-MM-DD}. */
  public String getPeriodStart() {
    return periodStart;
  }

  /** The first day after the period. */
  public String getPeriodEnd() {
    return periodEnd;
  }

  public double getIncluded() {
    return included;
  }

  public double getUsed() {
    return used;
  }

  public double getOverageUsed() {
    return overageUsed;
  }

  /** Prepaid units left now. */
  public double getOverageBalance() {
    return overageBalance;
  }

  /**
   * The units at which overage stops live renders; null without overage and for an earlier period.
   */
  public Double getHardCapUnits() {
    return hardCapUnits;
  }

  /** {@code date}, {@code units} and {@code renders} of each day. */
  public List<Map<String, Object>> getDaily() {
    return daily;
  }

  /** {@code template} and {@code units}. */
  public List<Map<String, Object>> getByTemplate() {
    return byTemplate;
  }

  public Map<String, Object> getRaw() {
    return raw;
  }

  @Override
  public String toString() {
    return "Usage{period=" + period + ", used=" + used + ", included=" + included + "}";
  }
}
