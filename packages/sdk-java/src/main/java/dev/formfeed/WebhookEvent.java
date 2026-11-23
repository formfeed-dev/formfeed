package dev.formfeed;

import java.util.Map;

/**
 * A verified webhook delivery: {@code render.completed}, {@code render.failed}, {@code
 * job.completed}, {@code job.failed} and the others the endpoint subscribed to. A render event's
 * data reads as {@code Render.fromMap(event.getData())}, a job event's as {@code
 * Job.fromMap(event.getData())}.
 */
public final class WebhookEvent {
  private final String id;
  private final String type;
  private final String createdAt;
  private final String workspaceId;
  private final Map<String, Object> data;
  private final Map<String, Object> raw;

  private WebhookEvent(Map<String, Object> event) {
    this.id = Fields.string(event, "id");
    this.type = Fields.string(event, "type");
    this.createdAt = Fields.string(event, "created_at");
    this.workspaceId = Fields.stringOrNull(event, "workspace_id");
    this.data = Fields.map(event, "data");
    this.raw = event;
  }

  /** Reads an event that was verified some other way. */
  public static WebhookEvent fromMap(Map<String, ?> event) {
    return new WebhookEvent(Fields.object(event));
  }

  /** The event's id, {@code evt_…}, which {@code webhooks().resend()} takes. */
  public String getId() {
    return id;
  }

  public String getType() {
    return type;
  }

  public String getCreatedAt() {
    return createdAt;
  }

  public String getWorkspaceId() {
    return workspaceId;
  }

  /** The render or job the event is about, as the API answers it. */
  public Map<String, Object> getData() {
    return data;
  }

  public Map<String, Object> getRaw() {
    return raw;
  }

  @Override
  public String toString() {
    return "WebhookEvent{id=" + id + ", type=" + type + "}";
  }
}
