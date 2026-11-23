package dev.formfeed;

import java.util.List;
import java.util.Map;

/** A template of the workspace, without its versions' content. */
public final class Template {
  private final String id;
  private final String slug;
  private final String name;
  private final String description;
  private final String kind;
  private final String engine;
  private final List<String> tags;
  private final Integer publishedVersion;
  private final int latestVersion;
  private final String createdAt;
  private final String updatedAt;
  private final Map<String, Object> raw;

  private Template(Map<String, Object> data) {
    this.id = Fields.string(data, "id");
    this.slug = Fields.string(data, "slug");
    this.name = Fields.string(data, "name");
    this.description = Fields.stringOrNull(data, "description");
    this.kind = Fields.string(data, "kind");
    this.engine = Fields.string(data, "engine");
    this.tags = Fields.strings(data, "tags");
    this.publishedVersion = Fields.integerOrNull(data, "published_version");
    this.latestVersion = Fields.integer(data, "latest_version");
    this.createdAt = Fields.string(data, "created_at");
    this.updatedAt = Fields.string(data, "updated_at");
    this.raw = data;
  }

  /** Reads a template as the API answers it. */
  public static Template fromMap(Map<String, ?> data) {
    return new Template(Fields.object(data));
  }

  /** {@code tpl_…}. */
  public String getId() {
    return id;
  }

  /** The name a render names it by. */
  public String getSlug() {
    return slug;
  }

  public String getName() {
    return name;
  }

  public String getDescription() {
    return description;
  }

  /** {@code pdf}, {@code image}, {@code docx} or {@code pptx}. */
  public String getKind() {
    return kind;
  }

  /** {@code jinja2}, {@code liquid} or {@code handlebars}. */
  public String getEngine() {
    return engine;
  }

  public List<String> getTags() {
    return tags;
  }

  /** The version renders use by default; null while none is published. */
  public Integer getPublishedVersion() {
    return publishedVersion;
  }

  public int getLatestVersion() {
    return latestVersion;
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
    return "Template{id=" + id + ", slug=" + slug + "}";
  }
}
