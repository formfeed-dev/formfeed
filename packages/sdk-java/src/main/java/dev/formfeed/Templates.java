package dev.formfeed;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The workspace's templates, read and checked. Writing them (versions, publishing, channels) is the
 * command line's and the app's; {@link Formfeed#request} reaches those calls.
 */
public final class Templates {
  private final Transport transport;

  Templates(Transport transport) {
    this.transport = transport;
  }

  /** The first page of templates, most recently changed first. */
  public Page<Template> list() {
    return list(Collections.emptyMap());
  }

  /**
   * One page of templates, most recently changed first.
   *
   * @param query {@code kind}, {@code engine}, {@code tag}, {@code q}, {@code limit}, {@code
   *     cursor}
   */
  public Page<Template> list(Map<String, ?> query) {
    return Page.fromMap(
        transport.object("GET", "/templates" + Query.string(query)), Template::fromMap);
  }

  /** Every template, page by page as you iterate. */
  public Iterable<Template> all() {
    return all(Collections.emptyMap());
  }

  /** Every template the query matches, page by page as you iterate. */
  public Iterable<Template> all(Map<String, ?> query) {
    return Paging.all(query, this::list);
  }

  /** A template by its slug, {@code tpl_…} id or UUID. */
  public Template get(String idOrSlug) {
    return Template.fromMap(transport.object("GET", "/templates/" + Ids.segment(idOrSlug)));
  }

  /**
   * The JSON Schema of the template's data, of the published (else the latest) version: stored,
   * else inferred from the sample data.
   */
  public Map<String, Object> schema(String idOrSlug) {
    return schemaOf(idOrSlug, null);
  }

  /**
   * The JSON Schema of the data of {@code version}: {@code published}, {@code latest} or a channel.
   */
  public Map<String, Object> schema(String idOrSlug, String version) {
    return schemaOf(idOrSlug, version);
  }

  /** The JSON Schema of the data of version number {@code version}. */
  public Map<String, Object> schema(String idOrSlug, int version) {
    return schemaOf(idOrSlug, version);
  }

  /**
   * Checks the published (else the latest) version with its sample data without rendering. Free.
   *
   * @return {@code ok}, the {@code template} and version checked, and the {@code diagnostics} found
   */
  public Map<String, Object> validate(String idOrSlug) {
    return validate(idOrSlug, Collections.emptyMap());
  }

  /**
   * Checks a version with data without rendering: syntax, header and footer, missing partials,
   * runtime errors and the data against the stored schema. Free. Without {@code data}, the
   * version's sample data is checked.
   *
   * @param input {@code version} and {@code data}
   * @return {@code ok}, the {@code template} and version checked, and the {@code diagnostics} found
   */
  public Map<String, Object> validate(String idOrSlug, Map<String, ?> input) {
    return transport.object(
        "POST", "/templates/" + Ids.segment(idOrSlug) + "/validate", input, null);
  }

  private Map<String, Object> schemaOf(String idOrSlug, Object version) {
    Map<String, Object> query = new LinkedHashMap<>();
    query.put("version", version);
    return transport.object(
        "GET", "/templates/" + Ids.segment(idOrSlug) + "/schema" + Query.string(query));
  }
}
