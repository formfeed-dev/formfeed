package dev.formfeed;

import java.util.Map;

/**
 * A file of the workspace's library: an image or PDF a template names, served at {@link #getUrl()}.
 */
public final class LibraryFile implements Source {
  private final String id;
  private final String name;
  private final String contentType;
  private final long bytes;
  private final String sha256;
  private final String url;
  private final String createdAt;
  private final String updatedAt;
  private final Map<String, Object> raw;

  private LibraryFile(Map<String, Object> data) {
    this.id = Fields.string(data, "id");
    this.name = Fields.string(data, "name");
    this.contentType = Fields.string(data, "content_type");
    this.bytes = Fields.longValue(data, "bytes");
    this.sha256 = Fields.string(data, "sha256");
    this.url = Fields.string(data, "url");
    this.createdAt = Fields.string(data, "created_at");
    this.updatedAt = Fields.string(data, "updated_at");
    this.raw = data;
  }

  /** Reads a library file as the API answers it. */
  public static LibraryFile fromMap(Map<String, ?> data) {
    return new LibraryFile(Fields.object(data));
  }

  /** {@code fil_…}. */
  public String getId() {
    return id;
  }

  /** The name a template names it by, such as {@code logo.png} or {@code brand/logo.png}. */
  public String getName() {
    return name;
  }

  public String getContentType() {
    return contentType;
  }

  public long getBytes() {
    return bytes;
  }

  public String getSha256() {
    return sha256;
  }

  /** Where the CDN serves it, without a signature. */
  public String getUrl() {
    return url;
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
    return "LibraryFile{id=" + id + ", name=" + name + "}";
  }
}
