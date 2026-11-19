<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Testing\Internal;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * The PSR-18 client the fake's SDK client sends to: nothing leaves the process.
 *
 * @internal
 */
final class FakeHttpClient implements ClientInterface
{
    /** @param \Closure(RequestInterface): ResponseInterface $handle */
    public function __construct(private readonly \Closure $handle) {}

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        return ($this->handle)($request);
    }
}
