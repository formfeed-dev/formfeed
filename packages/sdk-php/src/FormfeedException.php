<?php

declare(strict_types=1);

namespace Formfeed;

/**
 * An API problem (RFC 9457) or a failure on this side.
 *
 * `errorCode` is the problem's code (`quota_exceeded`, `template_not_found`, …), or `network_error`,
 * `timeout`, `not_ready`, `download_failed` or `invalid_response` for what went wrong before an
 * answer; `status` is the HTTP status, 0 when there was none; `requestId` the `X-Request-Id` the API
 * answered with, which support asks for.
 */
final class FormfeedException extends \RuntimeException
{
    /**
     * @param array<string, mixed>|null $problem the problem document as the API sent it
     */
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $status = 0,
        public readonly ?array $problem = null,
        public readonly ?string $requestId = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }
}
