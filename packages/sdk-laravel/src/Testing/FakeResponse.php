<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Testing;

/**
 * An answer the fake gives exactly as written: made by `FormfeedFake::response()` and
 * `FormfeedFake::problem()`.
 */
final class FakeResponse
{
    /**
     * @param array<mixed>|string|null $body  an array is sent as JSON, a string as it is
     * @param array<string, string>    $headers
     */
    public function __construct(
        public readonly int $status = 200,
        public readonly array|string|null $body = null,
        public readonly array $headers = [],
    ) {
        if ($status < 100 || $status > 599) {
            throw new \InvalidArgumentException("{$status} is no HTTP status");
        }
    }
}
