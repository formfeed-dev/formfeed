package dev.formfeed;

import java.util.Map;

/**
 * The stored request of a render, to render it again: a template render carries {@code template}
 * and {@code data}, an ad-hoc one {@code html}, {@code url} or {@code markdown}. Passwords are
 * never included.
 */
public final class RenderInput {
  private final String renderId;
  private final Map<String, Object> template;
  private final Map<String, Object> data;
  private final String html;
  private final String markdown;
  private final String url;
  private final String engine;
  private final String locale;
  private final String output;
  private final Map<String, Object> settings;
  private final String filename;
  private final Map<String, Object> post;
  private final Map<String, Object> meta;
  private final String environment;
  private final String createdAt;
  private final Map<String, Object> raw;

  private RenderInput(Map<String, Object> input) {
    this.renderId = Fields.string(input, "render_id");
    this.template = Fields.mapOrNull(input, "template");
    this.data = Fields.mapOrNull(input, "data");
    this.html = Fields.stringOrNull(input, "html");
    this.markdown = Fields.stringOrNull(input, "markdown");
    this.url = Fields.stringOrNull(input, "url");
    this.engine = Fields.stringOrNull(input, "engine");
    this.locale = Fields.stringOrNull(input, "locale");
    this.output = Fields.stringOrNull(input, "output");
    this.settings = Fields.mapOrNull(input, "settings");
    this.filename = Fields.stringOrNull(input, "filename");
    this.post = Fields.mapOrNull(input, "post");
    this.meta = Fields.map(input, "meta");
    this.environment = Fields.string(input, "environment");
    this.createdAt = Fields.string(input, "created_at");
    this.raw = input;
  }

  /** Reads a stored request as the API answers it. */
  public static RenderInput fromMap(Map<String, ?> input) {
    return new RenderInput(Fields.object(input));
  }

  public String getRenderId() {
    return renderId;
  }

  /** {@code id}, {@code slug}, {@code version} and {@code channel}. */
  public Map<String, Object> getTemplate() {
    return template;
  }

  public Map<String, Object> getData() {
    return data;
  }

  public String getHtml() {
    return html;
  }

  public String getMarkdown() {
    return markdown;
  }

  public String getUrl() {
    return url;
  }

  public String getEngine() {
    return engine;
  }

  public String getLocale() {
    return locale;
  }

  public String getOutput() {
    return output;
  }

  public Map<String, Object> getSettings() {
    return settings;
  }

  public String getFilename() {
    return filename;
  }

  public Map<String, Object> getPost() {
    return post;
  }

  public Map<String, Object> getMeta() {
    return meta;
  }

  public String getEnvironment() {
    return environment;
  }

  public String getCreatedAt() {
    return createdAt;
  }

  public Map<String, Object> getRaw() {
    return raw;
  }

  @Override
  public String toString() {
    return "RenderInput{renderId=" + renderId + "}";
  }
}
