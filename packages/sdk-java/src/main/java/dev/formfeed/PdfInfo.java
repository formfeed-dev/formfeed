package dev.formfeed;

import java.util.List;
import java.util.Map;

/**
 * What a PDF holds: its pages and their sizes, whether it is encrypted, its metadata, and its form
 * with every field's full name, the names {@code pdf().fill()} takes.
 */
public final class PdfInfo {
  private final String source;
  private final int pageCount;
  private final List<Map<String, Object>> pages;
  private final boolean encrypted;
  private final Map<String, Object> metadata;
  private final Map<String, Object> form;
  private final Map<String, Object> raw;

  private PdfInfo(Map<String, Object> data) {
    this.source = Fields.string(data, "source");
    this.pageCount = Fields.integer(data, "page_count");
    this.pages = Fields.objects(data, "pages");
    this.encrypted = Fields.bool(data, "encrypted", false);
    this.metadata = Fields.map(data, "metadata");
    this.form = Fields.mapOrNull(data, "form");
    this.raw = data;
  }

  /** Reads what the API answers for {@code /pdf/info}. */
  public static PdfInfo fromMap(Map<String, ?> data) {
    return new PdfInfo(Fields.object(data));
  }

  public String getSource() {
    return source;
  }

  public int getPageCount() {
    return pageCount;
  }

  /** {@code width_pt}, {@code height_pt}, {@code width_mm} and {@code height_mm} of each page. */
  public List<Map<String, Object>> getPages() {
    return pages;
  }

  public boolean isEncrypted() {
    return encrypted;
  }

  public Map<String, Object> getMetadata() {
    return metadata;
  }

  /** The form's fields, each with name, type, value and options; null for a PDF without a form. */
  public Map<String, Object> getForm() {
    return form;
  }

  public Map<String, Object> getRaw() {
    return raw;
  }

  @Override
  public String toString() {
    return "PdfInfo{source=" + source + ", pageCount=" + pageCount + "}";
  }
}
