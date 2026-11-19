<?php

declare(strict_types=1);

namespace Formfeed\Internal;

use Http\Discovery\Psr18ClientDiscovery;
use Psr\Http\Client\ClientInterface;

/**
 * The HTTP client when the caller passes none. PSR-18 has no time limit, so the two clients most
 * applications have get the SDK's (120 s, as every Formfeed SDK waits); anything else is found by
 * php-http/discovery with its own defaults, and a caller who needs a limit passes a configured one.
 *
 * @internal
 */
final class HttpClients
{
    public static function create(float $timeout): ClientInterface
    {
        // the two clients are optional packages, named as strings and checked with class_exists
        if (class_exists('GuzzleHttp\Client')) {
            // @phpstan-ignore argument.type
            $guzzle = (new \ReflectionClass('GuzzleHttp\Client'))->newInstance([
                'timeout' => $timeout,
                'connect_timeout' => min(10.0, $timeout),
                'http_errors' => false,
            ]);
            if ($guzzle instanceof ClientInterface) {
                return $guzzle;
            }
        }
        if (class_exists('Symfony\Component\HttpClient\Psr18Client') && class_exists('Symfony\Component\HttpClient\HttpClient')) {
            // @phpstan-ignore argument.type
            $inner = call_user_func(['Symfony\Component\HttpClient\HttpClient', 'create'], ['max_duration' => $timeout]);
            // @phpstan-ignore argument.type
            $symfony = (new \ReflectionClass('Symfony\Component\HttpClient\Psr18Client'))->newInstance($inner);
            if ($symfony instanceof ClientInterface) {
                return $symfony;
            }
        }

        return Psr18ClientDiscovery::find();
    }
}
