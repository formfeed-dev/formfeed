package dev.formfeed;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

/**
 * A file sent with a request: a PDF for the PDF tools, an office document to convert, an e-invoice
 * to validate, a file for the library. It is read into memory and sent as multipart; the API keeps
 * only what the library stores.
 */
public final class Upload implements Source {
  private final byte[] contents;
  private final String name;
  private final String contentType;

  private Upload(byte[] contents, String name, String contentType) {
    this.contents = contents;
    this.name = name;
    this.contentType = contentType;
  }

  /** The file at the path, under its own name. */
  public static Upload fromPath(Path path) {
    return fromPath(path, null, null);
  }

  /** The file at the path, sent as {@code name}. */
  public static Upload fromPath(Path path, String name) {
    return fromPath(path, name, null);
  }

  /**
   * The file at the path.
   *
   * @param name the file's name as sent; its own when null
   * @param contentType the media type; what the name says when null
   * @throws UncheckedIOException when the file cannot be read
   */
  public static Upload fromPath(Path path, String name, String contentType) {
    byte[] contents;
    try {
      contents = Files.readAllBytes(path);
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read " + path, e);
    }
    Path fileName = path.getFileName();
    String sent = name != null ? name : fileName == null ? "file" : fileName.toString();
    return new Upload(contents, sent, contentType != null ? contentType : typeOf(sent));
  }

  /** Bytes you hold, sent as {@code name}. */
  public static Upload fromBytes(byte[] contents, String name) {
    return fromBytes(contents, name, null);
  }

  /**
   * Bytes you hold, sent as {@code name} with the media type given (what the name says when null).
   */
  public static Upload fromBytes(byte[] contents, String name, String contentType) {
    return new Upload(contents.clone(), name, contentType != null ? contentType : typeOf(name));
  }

  /** A copy of the bytes. */
  public byte[] getContents() {
    return contents.clone();
  }

  public String getName() {
    return name;
  }

  public String getContentType() {
    return contentType;
  }

  byte[] contents() {
    return contents;
  }

  /** What the name says the file is; the API reads the format from the bytes either way. */
  private static String typeOf(String name) {
    int dot = name.lastIndexOf('.');
    String extension = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    switch (extension) {
      case "pdf":
        return "application/pdf";
      case "xml":
        return "application/xml";
      case "docx":
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      case "xlsx":
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case "pptx":
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      case "odt":
        return "application/vnd.oasis.opendocument.text";
      case "ods":
        return "application/vnd.oasis.opendocument.spreadsheet";
      case "odp":
        return "application/vnd.oasis.opendocument.presentation";
      case "rtf":
        return "application/rtf";
      case "html":
      case "htm":
        return "text/html";
      case "png":
        return "image/png";
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "webp":
        return "image/webp";
      case "gif":
        return "image/gif";
      case "svg":
        return "image/svg+xml";
      default:
        return "application/octet-stream";
    }
  }

  @Override
  public String toString() {
    return "Upload{name="
        + name
        + ", contentType="
        + contentType
        + ", bytes="
        + contents.length
        + "}";
  }
}
