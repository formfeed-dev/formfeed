<?php

declare(strict_types=1);

namespace Formfeed\Tests\Support;

use Psr\Http\Client\NetworkExceptionInterface;
use Psr\Http\Message\RequestInterface;

/** What a PSR-18 client throws when the connection fails. */
final class NetworkError extends \RuntimeException implements NetworkExceptionInterface
{
    public function __construct(private readonly RequestInterface $request)
    {
        parent::__construct('connection refused');
    }

    public function getRequest(): RequestInterface
    {
        return $this->request;
    }
}
