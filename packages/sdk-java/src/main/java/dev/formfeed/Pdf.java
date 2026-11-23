package dev.formfeed;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The PDF tools, on the output of an earlier render (a {@link Render} or its id), a PDF of the file
 * library (a {@link LibraryFile}, its id or its name), or, for info, split, compress, toImage,
 * redact and fill, an {@link Upload}, which is never stored. Every tool but info answers a new
 * render, on the Starter plan and above: merge, protect, watermark, split, compress, redact and
 * fill cost 0.5 units each on live keys, toImage one unit per picture; info is free. Options are
 * maps with the API's field names, so a field the API adds needs no new SDK.
 */
public final class Pdf {
  private final Transport transport;

  Pdf(Transport transport) {
    this.transport = transport;
  }

  /** Joins PDFs in the order given: renders, library files, and their ids or names. */
  public Render merge(List<?> sources) {
    return merge(sources, Collections.emptyMap(), null);
  }

  /**
   * Joins PDFs in the order given.
   *
   * @param sources renders, library files, and their ids or names
   * @param options {@code filename}, {@code expires_in}, …
   */
  public Render merge(List<?> sources, Map<String, ?> options) {
    return merge(sources, options, null);
  }

  /** {@link #merge(List, Map)} with your own Idempotency-Key; null generates one. */
  public Render merge(List<?> sources, Map<String, ?> options, String idempotencyKey) {
    List<String> ids = new ArrayList<>();
    for (Object source : sources) {
      ids.add(Ids.of(source, "merge"));
    }
    Map<String, Object> body = new LinkedHashMap<>(options);
    body.put("sources", ids);
    return render("/pdf/merge", body, idempotencyKey);
  }

  /**
   * Encrypts a PDF with AES-256 ({@code user_password}, {@code owner_password}, {@code
   * permissions}).
   */
  public Render protect(Source source, Map<String, ?> options) {
    return protect(source, options, null);
  }

  /** Encrypts a stored PDF, named by its id. */
  public Render protect(String source, Map<String, ?> options) {
    return protect(source, options, null);
  }

  /** {@link #protect(Source, Map)} with your own Idempotency-Key; null generates one. */
  public Render protect(Source source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/protect", stored(source, options, "protect"), idempotencyKey);
  }

  /** {@link #protect(String, Map)} with your own Idempotency-Key; null generates one. */
  public Render protect(String source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/protect", stored(source, options, "protect"), idempotencyKey);
  }

  /** Stamps a text or a library image on the pages. */
  public Render watermark(Source source, Map<String, ?> options) {
    return watermark(source, options, null);
  }

  /** Stamps a text or a library image on the pages of a stored PDF, named by its id. */
  public Render watermark(String source, Map<String, ?> options) {
    return watermark(source, options, null);
  }

  /** {@link #watermark(Source, Map)} with your own Idempotency-Key; null generates one. */
  public Render watermark(Source source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/watermark", stored(source, options, "watermark"), idempotencyKey);
  }

  /** {@link #watermark(String, Map)} with your own Idempotency-Key; null generates one. */
  public Render watermark(String source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/watermark", stored(source, options, "watermark"), idempotencyKey);
  }

  /**
   * Page count, page sizes, encryption, metadata and the form with every field's name, type, value
   * and options, which is how a form's names are found for {@link #fill}. Free; creates no render.
   */
  public PdfInfo info(Source source) {
    return PdfInfo.fromMap(
        transport.object("POST", "/pdf/info", body(source, Collections.emptyMap()), null));
  }

  /** {@link #info(Source)} of a stored PDF, named by its id. */
  public PdfInfo info(String source) {
    return PdfInfo.fromMap(
        transport.object("POST", "/pdf/info", body(source, Collections.emptyMap()), null));
  }

  /**
   * Cuts a PDF into parts, {@code every} pages each or one per entry of {@code ranges}: a ZIP of
   * the parts, or the PDF itself for one part.
   */
  public Render split(Source source, Map<String, ?> options) {
    return split(source, options, null);
  }

  /** {@link #split(Source, Map)} of a stored PDF, named by its id. */
  public Render split(String source, Map<String, ?> options) {
    return split(source, options, null);
  }

  /** {@link #split(Source, Map)} with your own Idempotency-Key; null generates one. */
  public Render split(Source source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/split", body(source, options), idempotencyKey);
  }

  /** {@link #split(String, Map)} with your own Idempotency-Key; null generates one. */
  public Render split(String source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/split", body(source, options), idempotencyKey);
  }

  /** Makes a PDF smaller; the render keeps the source when it cannot. */
  public Render compress(Source source) {
    return compress(source, Collections.emptyMap(), null);
  }

  /** {@link #compress(Source)} of a stored PDF, named by its id. */
  public Render compress(String source) {
    return compress(source, Collections.emptyMap(), null);
  }

  /** Makes a PDF smaller, with {@code filename}, {@code expires_in}, … */
  public Render compress(Source source, Map<String, ?> options) {
    return compress(source, options, null);
  }

  /** {@link #compress(Source, Map)} of a stored PDF, named by its id. */
  public Render compress(String source, Map<String, ?> options) {
    return compress(source, options, null);
  }

  /** {@link #compress(Source, Map)} with your own Idempotency-Key; null generates one. */
  public Render compress(Source source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/compress", body(source, options), idempotencyKey);
  }

  /** {@link #compress(String, Map)} with your own Idempotency-Key; null generates one. */
  public Render compress(String source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/compress", body(source, options), idempotencyKey);
  }

  /** Draws the pages as PNG pictures: one page answers the picture, several a ZIP of them. */
  public Render toImage(Source source) {
    return toImage(source, Collections.emptyMap(), null);
  }

  /** {@link #toImage(Source)} of a stored PDF, named by its id. */
  public Render toImage(String source) {
    return toImage(source, Collections.emptyMap(), null);
  }

  /** Draws pages as PNG or JPEG pictures ({@code format}, {@code pages}, {@code dpi}, …). */
  public Render toImage(Source source, Map<String, ?> options) {
    return toImage(source, options, null);
  }

  /** {@link #toImage(Source, Map)} of a stored PDF, named by its id. */
  public Render toImage(String source, Map<String, ?> options) {
    return toImage(source, options, null);
  }

  /** {@link #toImage(Source, Map)} with your own Idempotency-Key; null generates one. */
  public Render toImage(Source source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/to-image", body(source, options), idempotencyKey);
  }

  /** {@link #toImage(String, Map)} with your own Idempotency-Key; null generates one. */
  public Render toImage(String source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/to-image", body(source, options), idempotencyKey);
  }

  /**
   * Removes what lies under the rectangles ({@code regions}) and every place a text stands ({@code
   * text}), from the file itself, and reads the result again: text still there fails the render
   * with {@code redaction_incomplete}, which names regions and texts by number, never a text. A
   * {@code fill} of null draws no box.
   */
  public Render redact(Source source, Map<String, ?> options) {
    return redact(source, options, null);
  }

  /** {@link #redact(Source, Map)} of a stored PDF, named by its id. */
  public Render redact(String source, Map<String, ?> options) {
    return redact(source, options, null);
  }

  /** {@link #redact(Source, Map)} with your own Idempotency-Key; null generates one. */
  public Render redact(Source source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/redact", body(source, options), idempotencyKey);
  }

  /** {@link #redact(String, Map)} with your own Idempotency-Key; null generates one. */
  public Render redact(String source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/redact", body(source, options), idempotencyKey);
  }

  /**
   * Fills a form's fields by their full names ({@code fields}) and keeps it fillable, or with
   * {@code flatten} draws the values into the pages. The values are never stored.
   */
  public Render fill(Source source, Map<String, ?> options) {
    return fill(source, options, null);
  }

  /** {@link #fill(Source, Map)} of a stored PDF, named by its id. */
  public Render fill(String source, Map<String, ?> options) {
    return fill(source, options, null);
  }

  /** {@link #fill(Source, Map)} with your own Idempotency-Key; null generates one. */
  public Render fill(Source source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/fill", body(source, options), idempotencyKey);
  }

  /** {@link #fill(String, Map)} with your own Idempotency-Key; null generates one. */
  public Render fill(String source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/fill", body(source, options), idempotencyKey);
  }

  /**
   * Converts an office document to a PDF render (Starter plan and above): an {@link Upload} (Word,
   * Excel, PowerPoint, OpenDocument, RTF or HTML, up to 20 MB, not kept), or the output of a Word
   * or PowerPoint template render.
   */
  public Render convert(Source source) {
    return convert(source, Collections.emptyMap(), null);
  }

  /** {@link #convert(Source)} of a render's output, named by its id. */
  public Render convert(String source) {
    return convert(source, Collections.emptyMap(), null);
  }

  /** {@link #convert(Source)} with {@code filename}, {@code expires_in}, … */
  public Render convert(Source source, Map<String, ?> options) {
    return convert(source, options, null);
  }

  /** {@link #convert(String)} with {@code filename}, {@code expires_in}, … */
  public Render convert(String source, Map<String, ?> options) {
    return convert(source, options, null);
  }

  /** {@link #convert(Source, Map)} with your own Idempotency-Key; null generates one. */
  public Render convert(Source source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/convert", body(source, options), idempotencyKey);
  }

  /** {@link #convert(String, Map)} with your own Idempotency-Key; null generates one. */
  public Render convert(String source, Map<String, ?> options, String idempotencyKey) {
    return render("/pdf/convert", body(source, options), idempotencyKey);
  }

  private Render render(String path, Object body, String idempotencyKey) {
    return Render.fromMap(transport.object("POST", path, body, Ids.keyOr(idempotencyKey)));
  }

  /**
   * A tool's request: a stored source by its id as JSON, an upload as multipart beside the options.
   */
  private Object body(Object source, Map<String, ?> options) {
    if (source instanceof Upload) {
      return new Multipart(options, (Upload) source, transport.json());
    }
    Map<String, Object> body = new LinkedHashMap<>(options);
    body.put("source", Ids.of(source, "a PDF tool"));
    return body;
  }

  /** The request of a tool that works on stored PDFs only. */
  private static Map<String, Object> stored(Object source, Map<String, ?> options, String tool) {
    if (source instanceof Upload) {
      throw new IllegalArgumentException(
          tool
              + " takes a stored PDF: a render, a library file or its id; upload the file to the library first");
    }
    Map<String, Object> body = new LinkedHashMap<>(options);
    body.put("source", Ids.of(source, tool));
    return body;
  }
}
