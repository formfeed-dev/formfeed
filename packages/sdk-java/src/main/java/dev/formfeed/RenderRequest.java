package dev.formfeed;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One render, built from its source: a stored {@link #template(String) template}, ad-hoc {@link
 * #html(String) HTML}, a public {@link #url(String) URL} or a {@link #markdown(String) Markdown}
 * document.
 *
 * <pre>{@code
 * RenderRequest.template("invoice").data(Map.of("number", "2026-0042")).output("pdf");
 * RenderRequest.html("<h1>Report</h1>").settings(Map.of("paper", Map.of("format", "A4")));
 * }</pre>
 *
 * <p>The setters name the fields most renders use; {@link #set(String, Object)} sends any other the
 * API documents, so a field of a later API needs no new SDK. {@code renders().create()} also takes
 * the request as a plain map, and a batch's {@code items} take requests of either kind.
 */
public final class RenderRequest {
  private final Map<String, Object> fields = new LinkedHashMap<>();

  private RenderRequest(String source, String value) {
    fields.put(source, value);
  }

  /** A stored template, by slug, {@code tpl_…} id or UUID. */
  public static RenderRequest template(String idOrSlug) {
    return new RenderRequest("template", idOrSlug);
  }

  /** Ad-hoc HTML, at most 5 MB; a template over {@code data} when an {@link #engine} is set. */
  public static RenderRequest html(String html) {
    return new RenderRequest("html", html);
  }

  /** A public https page to print. */
  public static RenderRequest url(String url) {
    return new RenderRequest("url", url);
  }

  /**
   * A Markdown document, at most 1 MB; a template over {@code data} when an {@link #engine} is set.
   */
  public static RenderRequest markdown(String markdown) {
    return new RenderRequest("markdown", markdown);
  }

  /**
   * The data the template renders with: a map, or any object Jackson writes as a JSON object.
   * {@code {}} when left out.
   */
  public RenderRequest data(Object data) {
    return set("data", data);
  }

  /** {@code pdf}, {@code png}, {@code jpg}, {@code webp}, {@code docx} or {@code pptx}. */
  public RenderRequest output(String output) {
    return set("output", output);
  }

  /** {@code published} (the default), a release channel's name, {@code latest} or a number. */
  public RenderRequest version(String version) {
    return set("version", version);
  }

  /** {@code jinja2}, {@code liquid} or {@code handlebars}, for {@code html} or {@code markdown}. */
  public RenderRequest engine(String engine) {
    return set("engine", engine);
  }

  /** Page, image, PDF and Markdown settings over the template's own. */
  public RenderRequest settings(Map<String, ?> settings) {
    return set("settings", settings);
  }

  /** The output file's name. */
  public RenderRequest filename(String filename) {
    return set("filename", filename);
  }

  /** Seconds until the output expires; it can shorten the plan's retention, never lengthen it. */
  public RenderRequest expiresIn(long seconds) {
    return set("expires_in", seconds);
  }

  /** {@code sync} (the default) or {@code async}, which answers the render queued. */
  public RenderRequest mode(String mode) {
    return set("mode", mode);
  }

  /** Formats dates and numbers and picks the translation dictionary, such as {@code de-DE}. */
  public RenderRequest locale(String locale) {
    return set("locale", locale);
  }

  /** Receives {@code render.completed} or {@code render.failed} for this render. */
  public RenderRequest webhookUrl(String url) {
    return set("webhook_url", url);
  }

  /** Signs the deliveries to {@link #webhookUrl(String)}. */
  public RenderRequest webhookSecret(String secret) {
    return set("webhook_secret", secret);
  }

  /** Your own data, returned unchanged with the render and in its webhook events. */
  public RenderRequest meta(Map<String, ?> meta) {
    return set("meta", meta);
  }

  /** Checks {@code data} against the template's stored schema before anything is counted. */
  public RenderRequest validateData(boolean validate) {
    return set("validate_data", validate);
  }

  /**
   * What happens to the PDF afterwards: {@code merge_after}, {@code watermark}, {@code password},
   * {@code einvoice}.
   */
  public RenderRequest post(Map<String, ?> post) {
    return set("post", post);
  }

  /** Any field of the request, as the API names it; null removes it. */
  public RenderRequest set(String field, Object value) {
    if (value == null) {
      fields.remove(field);
    } else {
      fields.put(field, value);
    }
    return this;
  }

  /** The request as it is sent, which is also how Jackson writes it (in a batch's items, say). */
  @JsonValue
  public Map<String, Object> toMap() {
    return Collections.unmodifiableMap(new LinkedHashMap<>(fields));
  }

  @Override
  public String toString() {
    return "RenderRequest" + fields.keySet();
  }
}
