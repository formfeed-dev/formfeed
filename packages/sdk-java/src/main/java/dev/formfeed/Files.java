package dev.formfeed;

import java.util.Collections;
import java.util.Map;

/**
 * The workspace's file library: images and PDFs a template names with {@code asset('logo.png')},
 * and the sources of image watermarks and merges. Needs {@code file:read}, {@code file:write} or
 * {@code file:delete}. Files are served without a signature, so keep confidential documents out of
 * it.
 */
public final class Files {
  private final Transport transport;

  Files(Transport transport) {
    this.transport = transport;
  }

  /** Uploads a file; one of the same name is replaced in place and keeps its URL. */
  public LibraryFile upload(Upload file) {
    return LibraryFile.fromMap(
        transport.object(
            "POST",
            "/files",
            new Multipart(Map.of("name", file.getName()), file, transport.json()),
            null));
  }

  /** The first page of files, newest first. */
  public Page<LibraryFile> list() {
    return list(Collections.emptyMap());
  }

  /**
   * One page of files, newest first.
   *
   * @param query {@code prefix} (the names that start with it), {@code limit}, {@code cursor}
   */
  public Page<LibraryFile> list(Map<String, ?> query) {
    return Page.fromMap(
        transport.object("GET", "/files" + Query.string(query)), LibraryFile::fromMap);
  }

  /** Every file, page by page as you iterate. */
  public Iterable<LibraryFile> all() {
    return all(Collections.emptyMap());
  }

  /** Every file the query matches, page by page as you iterate. */
  public Iterable<LibraryFile> all(Map<String, ?> query) {
    return Paging.all(query, this::list);
  }

  /** A file by its id ({@code fil_…}). */
  public LibraryFile get(String id) {
    return LibraryFile.fromMap(transport.object("GET", "/files/" + Ids.segment(id)));
  }

  /** The file again, as it is now. */
  public LibraryFile get(LibraryFile file) {
    return get(file.getId());
  }

  /** Removes the file and its bytes; templates that name it render a missing image afterwards. */
  public void delete(String id) {
    transport.call("DELETE", "/files/" + Ids.segment(id), null, null);
  }

  /** Removes the file and its bytes. */
  public void delete(LibraryFile file) {
    delete(file.getId());
  }
}
