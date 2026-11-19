<?php

declare(strict_types=1);

namespace Formfeed\Tests;

use Formfeed\Client;
use Formfeed\Tests\Support\ClientTestCase;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * The SDK's half of the operations table (plan 34, decision 9): `operations.json` names a method for
 * every operation of the API, or why there is none. `packages/api-types/src/lib/sdk-fixtures.spec.ts`
 * holds the names to the API; this holds them to the client, so a renamed method fails here.
 */
final class OperationsTest extends ClientTestCase
{
    /** @return array<string, array{string, string}> */
    public static function named(): array
    {
        $map = json_decode((string) file_get_contents(dirname(__DIR__) . '/operations.json'), true, 512, JSON_THROW_ON_ERROR);
        $operations = is_array($map) && is_array($map['operations'] ?? null) ? $map['operations'] : [];
        $out = [];
        foreach ($operations as $operation => $path) {
            if (is_string($path)) {
                $out[(string) $operation] = [(string) $operation, $path];
            }
        }

        return $out;
    }

    public function testTheFirstReleaseNamesItsThirtyFourOperations(): void
    {
        self::assertCount(34, self::named());
    }

    #[DataProvider('named')]
    public function testTheNamedMethodExists(string $operation, string $path): void
    {
        [$client] = $this->client(fn() => self::json([]));
        [$service, $method] = explode('.', $path) + [1 => ''];
        self::assertTrue(property_exists(Client::class, $service), "{$operation}: no service {$service}");
        self::assertTrue(method_exists($client->{$service}, $method), "{$operation}: no method {$path}");
    }
}
