package dev.formfeed;

/**
 * An API problem (RFC 9457) or a failure on this side.
 *
 * <p>{@link #getCode()} is the problem's code ({@code quota_exceeded}, {@code template_not_found},
 * …), or {@code network_error}, {@code timeout}, {@code not_ready}, {@code download_failed}, {@code
 * invalid_response}, {@code invalid_request} or {@code interrupted} for what went wrong before an
 * answer; {@link #getStatus()} is the HTTP status, 0 when there was none; {@link #getRequestId()}
 * the {@code X-Request-Id} the API answered with, which support asks for.
 *
 * <pre>{@code
 * try {
 *     formfeed.renders().create(RenderRequest.template("invoice").data(data));
 * } catch (FormfeedException e) {
 *     log.warn("{} ({}): {} [{}]", e.getCode(), e.getStatus(), e.getMessage(), e.getRequestId());
 * }
 * }</pre>
 */
public final class FormfeedException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  private final String code;
  private final int status;
  private final transient Problem problem;
  private final String requestId;

  /** A failure without an answer: no status, no problem. */
  public FormfeedException(String code, String message) {
    this(code, message, 0, null, null, null);
  }

  /**
   * @param code the problem's code, or what failed on this side
   * @param message the problem's detail, else its title
   * @param status the HTTP status, 0 when there was none
   * @param problem the problem document as the API sent it, or null
   * @param requestId the {@code X-Request-Id} of the answer, or null
   * @param cause what caused it on this side, or null
   */
  public FormfeedException(
      String code, String message, int status, Problem problem, String requestId, Throwable cause) {
    super(message, cause);
    this.code = code;
    this.status = status;
    this.problem = problem;
    this.requestId = requestId;
  }

  /** The stable code to branch on, such as {@code quota_exceeded}. */
  public String getCode() {
    return code;
  }

  /** The HTTP status, 0 when there was no answer. */
  public int getStatus() {
    return status;
  }

  /** The problem document as the API sent it, with every member; null when there was none. */
  public Problem getProblem() {
    return problem;
  }

  /** The {@code X-Request-Id} of the answer, which support asks for; null when there was none. */
  public String getRequestId() {
    return requestId;
  }
}
