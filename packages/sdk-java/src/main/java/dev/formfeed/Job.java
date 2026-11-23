package dev.formfeed;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * A batch, or a render queued with its own webhook URL: its renders in the order of the request
 * and, once they are done, a ZIP of their files.
 */
public final class Job {
  private final String id;
  private final String type;
  private final String status;
  private final int total;
  private final int succeeded;
  private final int failed;
  private final String zipUrl;
  private final String zipExpiresAt;
  private final Map<String, Object> storage;
  private final List<Render> items;
  private final Map<String, Object> meta;
  private final String createdAt;
  private final String completedAt;
  private final Map<String, Object> raw;

  private Job(Map<String, Object> data) {
    this.id = Fields.string(data, "id");
    this.type = Fields.string(data, "type");
    this.status = Fields.string(data, "status");
    this.total = Fields.integer(data, "total");
    this.succeeded = Fields.integer(data, "succeeded");
    this.failed = Fields.integer(data, "failed");
    this.zipUrl = Fields.stringOrNull(data, "zip_url");
    this.zipExpiresAt = Fields.stringOrNull(data, "zip_expires_at");
    this.storage = Fields.mapOrNull(data, "storage");
    List<Render> renders = new ArrayList<>();
    for (Map<String, Object> item : Fields.objects(data, "items")) {
      renders.add(Render.fromMap(item));
    }
    this.items = Collections.unmodifiableList(renders);
    this.meta = Fields.map(data, "meta");
    this.createdAt = Fields.string(data, "created_at");
    this.completedAt = Fields.stringOrNull(data, "completed_at");
    this.raw = data;
  }

  /** Reads a job as the API answers it. */
  public static Job fromMap(Map<String, ?> data) {
    return new Job(Fields.object(data));
  }

  /** {@code job_…}. */
  public String getId() {
    return id;
  }

  public String getType() {
    return type;
  }

  /**
   * {@code queued}, {@code processing}, {@code completed}, {@code partially_failed} or {@code
   * failed}.
   */
  public String getStatus() {
    return status;
  }

  public int getTotal() {
    return total;
  }

  public int getSucceeded() {
    return succeeded;
  }

  public int getFailed() {
    return failed;
  }

  /** The ZIP of the job's files, once they are done. */
  public String getZipUrl() {
    return zipUrl;
  }

  public String getZipExpiresAt() {
    return zipExpiresAt;
  }

  public Map<String, Object> getStorage() {
    return storage;
  }

  /** The job's renders, in the order of the request. */
  public List<Render> getItems() {
    return items;
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

  public Map<String, Object> getRaw() {
    return raw;
  }

  /** No render of it is queued or running any more. */
  public boolean isFinished() {
    return !"queued".equals(status) && !"processing".equals(status);
  }

  @Override
  public String toString() {
    return "Job{id=" + id + ", status=" + status + ", total=" + total + "}";
  }
}
