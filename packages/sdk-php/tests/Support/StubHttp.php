<?php

declare(strict_types=1);

namespace Formfeed\Tests\Support;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/** A PSR-18 client that answers from a closure and keeps every request it was sent. */
final class StubHttp implements ClientInterface
{
    /** @var list<RequestInterface> */
    public array $requests = [];

    /**
     * @param \Closure(RequestInterface, int): ResponseInterface $respond called with the request and its number, from 1
     */
    public function __construct(private readonly \Closure $respond) {}

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $this->requests[] = $request;

        return ($this->respond)($request, count($this->requests));
    }

    public function request(int $index): RequestInterface
    {
        return $this->requests[$index] ?? throw new \OutOfRangeException("no request {$index}");
    }
}
