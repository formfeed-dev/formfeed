package dev.formfeed;

import java.util.List;
import java.util.Map;

/**
 * An error as RFC 9457 problem details, as {@link FormfeedException#getProblem()} carries it. The
 * members a code adds ({@code errors}, {@code location}, {@code einvoice}, {@code feature}, …) are
 * in {@link #getRaw()}.
 */
public final class Problem {
  private final String type;
  private final String title;
  private final int status;
  private final String detail;
  private final String code;
  private final String requestId;
  private final String renderId;
  private final Map<String, Object> location;
  private final List<Map<String, Object>> errors;
  private final Map<String, Object> raw;

  private Problem(Map<String, Object> data) {
    this.type = Fields.string(data, "type");
    this.title = Fields.string(data, "title");
    this.status = Fields.integer(data, "status");
    this.detail = Fields.string(data, "detail");
    this.code = Fields.string(data, "code");
    this.requestId = Fields.stringOrNull(data, "request_id");
    this.renderId = Fields.stringOrNull(data, "render_id");
    this.location = Fields.mapOrNull(data, "location");
    this.errors = Fields.objects(data, "errors");
    this.raw = data;
  }

  /** Reads a problem document. */
  public static Problem fromMap(Map<String, ?> data) {
    return new Problem(Fields.object(data));
  }

  /** The page that explains this error. */
  public String getType() {
    return type;
  }

  public String getTitle() {
    return title;
  }

  public int getStatus() {
    return status;
  }

  /** What went wrong in this request, in English. */
  public String getDetail() {
    return detail;
  }

  /** The stable error code; branch on this, not on the title or the detail. */
  public String getCode() {
    return code;
  }

  public String getRequestId() {
    return requestId;
  }

  /** The failed render, for a render that failed after it was recorded; else null. */
  public String getRenderId() {
    return renderId;
  }

  /**
   * Where a template error is: {@code line} and {@code column}, or {@code part} and {@code
   * paragraph}.
   */
  public Map<String, Object> getLocation() {
    return location;
  }

  /** {@code data_validation_error} and {@code einvoice_data_invalid}: every place that failed. */
  public List<Map<String, Object>> getErrors() {
    return errors;
  }

  /** The problem as the API sent it, members of later API versions included. */
  public Map<String, Object> getRaw() {
    return raw;
  }

  @Override
  public String toString() {
    return "Problem{code=" + code + ", status=" + status + ", detail=" + detail + "}";
  }
}
