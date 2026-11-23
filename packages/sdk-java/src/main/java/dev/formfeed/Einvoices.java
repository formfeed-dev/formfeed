package dev.formfeed;

import java.util.LinkedHashMap;
import java.util.Map;

/** E-invoices: which rules one passed, by which validator and release. */
public final class Einvoices {
  private final Transport transport;

  Einvoices(Transport transport) {
    this.transport = transport;
  }

  /**
   * Which rules an e-invoice passed. A render of this workspace's own e-invoice (a {@link Render})
   * is answered from the report it keeps, free; an XML Formfeed did not make (an {@link Upload}, up
   * to 4 MB, from the Starter plan) takes one of the organisation's validations of the day. Needs
   * {@code einvoice:validate}.
   *
   * @return the report: {@code result}, the {@code checks} with their findings, {@code validator},
   *     {@code rules} and {@code versions}
   */
  public Map<String, Object> validate(Source source) {
    return validate(source, null, null);
  }

  /** {@link #validate(Source)} of a render, named by its id ({@code rnd_…}). */
  public Map<String, Object> validate(String renderId) {
    return validate(renderId, null, null);
  }

  /**
   * {@link #validate(Source)} by the rules named.
   *
   * @param rules {@code auto}, {@code factur-x}, {@code xrechnung} or {@code en16931}; the render's
   *     own when null
   */
  public Map<String, Object> validate(Source source, String rules) {
    return validate(source, rules, null);
  }

  /** {@link #validate(String)} by the rules named; the render's own when null. */
  public Map<String, Object> validate(String renderId, String rules) {
    return validate(renderId, rules, null);
  }

  /** {@link #validate(Source, String)} with your own Idempotency-Key; null generates one. */
  public Map<String, Object> validate(Source source, String rules, String idempotencyKey) {
    if (source instanceof LibraryFile) {
      throw new IllegalArgumentException(
          "an e-invoice is validated from a render or an upload, not a library file");
    }
    return send(source, rules, idempotencyKey);
  }

  /** {@link #validate(String, String)} with your own Idempotency-Key; null generates one. */
  public Map<String, Object> validate(String renderId, String rules, String idempotencyKey) {
    return send(renderId, rules, idempotencyKey);
  }

  private Map<String, Object> send(Object source, String rules, String idempotencyKey) {
    Object body;
    if (source instanceof Upload) {
      Map<String, Object> fields = new LinkedHashMap<>();
      fields.put("rules", rules);
      body = new Multipart(fields, (Upload) source, transport.json());
    } else {
      Map<String, Object> json = new LinkedHashMap<>();
      json.put("render_id", Ids.of(source, "an e-invoice check"));
      if (rules != null) {
        json.put("rules", rules);
      }
      body = json;
    }
    return transport.object("POST", "/einvoices/validate", body, Ids.keyOr(idempotencyKey));
  }
}
