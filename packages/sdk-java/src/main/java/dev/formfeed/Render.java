package dev.formfeed;

import java.util.Map;

/**
 * A render: its status, its output's signed link and what it cost. {@link #getRaw()} holds the
 * answer as the API sent it, fields of later API versions included. Values such as the status stay
 * plain strings, so a value the API adds later never breaks a read.
 */
public final class Render implements Source {
  private final String id;
  private final String status;
  private final String output;
  private final String downloadUrl;
  private final String expiresAt;
  private final Long bytes;
  private final Integer pageCount;
  private final double units;
  private final String region;
  private final String environment;
  private final Map<String, Object> template;
  private final String engineVersion;
  private final String outputSha256;
  private final boolean deduplicated;
  private final Map<String, Object> storage;
  private final Map<String, Object> einvoice;
  private final Map<String, Object> accessibility;
  private final Map<String, Object> pdfa;
  private final Map<String, Object> form;
  private final Map<String, Object> timings;
  private final Map<String, Object> error;
  private final Map<String, Object> meta;
  private final String createdAt;
  private final String completedAt;
  private final Map<String, Object> raw;

  private Render(Map<String, Object> data) {
    this.id = Fields.string(data, "id");
    this.status = Fields.string(data, "status");
    this.output = Fields.string(data, "output");
    this.downloadUrl = Fields.stringOrNull(data, "download_url");
    this.expiresAt = Fields.stringOrNull(data, "expires_at");
    this.bytes = Fields.longOrNull(data, "bytes");
    this.pageCount = Fields.integerOrNull(data, "page_count");
    this.units = Fields.number(data, "units");
    this.region = Fields.string(data, "region");
    this.environment = Fields.string(data, "environment");
    this.template = Fields.mapOrNull(data, "template");
    this.engineVersion = Fields.stringOrNull(data, "engine_version");
    this.outputSha256 = Fields.stringOrNull(data, "output_sha256");
    this.deduplicated = Fields.bool(data, "deduplicated", false);
    this.storage = Fields.mapOrNull(data, "storage");
    this.einvoice = Fields.mapOrNull(data, "einvoice");
    this.accessibility = Fields.mapOrNull(data, "accessibility");
    this.pdfa = Fields.mapOrNull(data, "pdfa");
    this.form = Fields.mapOrNull(data, "form");
    this.timings = Fields.mapOrNull(data, "timings");
    this.error = Fields.mapOrNull(data, "error");
    this.meta = Fields.map(data, "meta");
    this.createdAt = Fields.string(data, "created_at");
    this.completedAt = Fields.stringOrNull(data, "completed_at");
    this.raw = data;
  }

  /** Reads a render as the API answers it, for one that arrives in a webhook event, say. */
  public static Render fromMap(Map<String, ?> data) {
    return new Render(Fields.object(data));
  }

  /** {@code rnd_…}. */
  public String getId() {
    return id;
  }

  /** {@code queued}, {@code rendering}, {@code succeeded} or {@code failed}. */
  public String getStatus() {
    return status;
  }

  /**
   * The format: {@code pdf}, {@code png}, {@code jpg}, {@code webp}, {@code docx}, {@code zip}, …
   */
  public String getOutput() {
    return output;
  }

  /**
   * The output's link, signed unless the workspace serves outputs publicly; null until it exists.
   */
  public String getDownloadUrl() {
    return downloadUrl;
  }

  public String getExpiresAt() {
    return expiresAt;
  }

  public Long getBytes() {
    return bytes;
  }

  public Integer getPageCount() {
    return pageCount;
  }

  /** What the render cost. */
  public double getUnits() {
    return units;
  }

  public String getRegion() {
    return region;
  }

  /** {@code live} or {@code test}. */
  public String getEnvironment() {
    return environment;
  }

  /**
   * {@code id}, {@code slug}, {@code version}, and {@code channel} and {@code canary} where they
   * apply.
   */
  public Map<String, Object> getTemplate() {
    return template;
  }

  public String getEngineVersion() {
    return engineVersion;
  }

  public String getOutputSha256() {
    return outputSha256;
  }

  /** Whether an identical render of the last 24 hours answered this one. */
  public boolean isDeduplicated() {
    return deduplicated;
  }

  /** The copy to the workspace's own bucket. */
  public Map<String, Object> getStorage() {
    return storage;
  }

  /** The e-invoice report. */
  public Map<String, Object> getEinvoice() {
    return einvoice;
  }

  /** The PDF/UA-1 verdict. */
  public Map<String, Object> getAccessibility() {
    return accessibility;
  }

  /** The PDF/A verdict. */
  public Map<String, Object> getPdfa() {
    return pdfa;
  }

  /** What a fill did. */
  public Map<String, Object> getForm() {
    return form;
  }

  /** Milliseconds per stage. */
  public Map<String, Object> getTimings() {
    return timings;
  }

  /** {@code code} and {@code message} of a failed render; null otherwise. */
  public Map<String, Object> getError() {
    return error;
  }

  public Map<String, Object> getMeta() {
    return meta;
  }

  public String getCreatedAt() {
    return createdAt;
  }

  public String getCompletedAt() {
    return completedAt;
  }

  /** The render as the API sent it. */
  public Map<String, Object> getRaw() {
    return raw;
  }

  /** Succeeded or failed: nothing will change any more. */
  public boolean isFinished() {
    return "succeeded".equals(status) || "failed".equals(status);
  }

  @Override
  public String toString() {
    return "Render{id=" + id + ", status=" + status + ", output=" + output + "}";
  }
}
