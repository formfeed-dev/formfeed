using System;

namespace Formfeed;

/// <summary>
/// An API problem (RFC 9457) or a failure on this side.
/// </summary>
/// <remarks>
/// <see cref="Code"/> is the problem's code (<c>quota_exceeded</c>, <c>template_not_found</c>, …), or
/// <c>network_error</c>, <c>timeout</c>, <c>not_ready</c>, <c>download_failed</c>,
/// <c>invalid_response</c> or <c>invalid_request</c> for what went wrong before an answer;
/// <see cref="Status"/> is the HTTP status, 0 when there was none; <see cref="RequestId"/> the
/// <c>X-Request-Id</c> the API answered with, which support asks for. A call you cancel throws
/// <see cref="OperationCanceledException"/> instead.
/// </remarks>
public sealed class FormfeedException : Exception
{
    /// <summary>An error with its code and message; the API's are made by the client.</summary>
    public FormfeedException(
        string code,
        string message,
        int status = 0,
        Problem? problem = null,
        string? requestId = null,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
        Status = status;
        Problem = problem;
        RequestId = requestId;
    }

    /// <summary>The problem's code, or <c>http_&lt;status&gt;</c> when the answer named none.</summary>
    public string Code { get; }

    /// <summary>The HTTP status; 0 when there was no answer.</summary>
    public int Status { get; }

    /// <summary>The problem document as the API sent it; null when the answer had none.</summary>
    public Problem? Problem { get; }

    /// <summary>The <c>X-Request-Id</c> of the answer.</summary>
    public string? RequestId { get; }
}
