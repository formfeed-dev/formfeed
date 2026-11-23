package dev.formfeed;

import java.util.List;
import java.util.Map;

/** A registered webhook endpoint. {@link #getSecret()} is only in the answer that created it. */
public final class WebhookEndpoint {
  private final String id;
  private final String url;
  private final List<String> events;
  private final List<String> environments;
  private final boolean enabled;
  private final String description;
  private final int consecutiveFailures;
  private final String secret;
  private final String createdAt;
  private final String updatedAt;
  private final Map<String, Object> raw;

  private WebhookEndpoint(Map<String, Object> data) {
    this.id = Fields.string(data, "id");
    this.url = Fields.string(data, "url");
    this.events = Fields.strings(data, "events");
    this.environments = Fields.strings(data, "environments");
    this.enabled = Fields.bool(data, "enabled", true);
    this.description = Fields.stringOrNull(data, "description");
    this.consecutiveFailures = Fields.integer(data, "consecutive_failures");
    this.secret = Fields.stringOrNull(data, "secret");
    this.createdAt = Fields.string(data, "created_at");
    this.updatedAt = Fields.string(data, "updated_at");
    this.raw = data;
  }

  /** Reads an endpoint as the API answers it. */
  public static WebhookEndpoint fromMap(Map<String, ?> data) {
    return new WebhookEndpoint(Fields.object(data));
  }

  public String getId() {
    return id;
  }

  public String getUrl() {
    return url;
  }

  /** The event types it receives, such as {@code render.completed}. */
  public List<String> getEvents() {
    return events;
  }

  /** The render environments it receives events of: {@code live}, {@code test}. */
  public List<String> getEnvironments() {
    return environments;
  }

  public boolean isEnabled() {
    return enabled;
  }

  public String getDescription() {
    return description;
  }

  public int getConsecutiveFailures() {
    return consecutiveFailures;
  }

  /** The signing secret, in the answer of {@code webhooks().create()} only. */
  public String getSecret() {
    return secret;
  }

  public String getCreatedAt() {
    return createdAt;
  }

  public String getUpdatedAt() {
    return updatedAt;
  }

  public Map<String, Object> getRaw() {
    return raw;
  }

  @Override
  public String toString() {
    return "WebhookEndpoint{id=" + id + ", url=" + url + "}";
  }
}
