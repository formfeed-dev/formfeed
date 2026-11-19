<?php

declare(strict_types=1);

namespace Formfeed\Tests;

use Formfeed\FormfeedException;
use Formfeed\Tests\Support\ClientTestCase;
use Formfeed\Tests\Support\NetworkError;
use Formfeed\Webhook;
use Nyholm\Psr7\Response;
use PHPUnit\Framework\Attributes\DataProvider;
use Psr\Http\Message\RequestInterface;

/**
 * The test vectors every Formfeed SDK reads (plan 34, decision 9), written by
 * `packages/api-types/src/lib/sdk-fixtures.spec.ts`: webhook signatures, retries and problems,
 * played through the client as a caller meets them.
 */
final class VectorsTest extends ClientTestCase
{
    /** @return array<string, mixed> */
    private static function vectors(string $name): array
    {
        $path = dirname(__DIR__, 2) . "/api-types/fixtures/sdk/{$name}.json";
        $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($decoded)) {
            throw new \RuntimeException("{$path} is not a JSON object");
        }

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    /** @return array<string, array{array<string, mixed>}> */
    private static function cases(string $name): array
    {
        $cases = self::vectors($name)['cases'] ?? [];
        $out = [];
        foreach (is_array($cases) ? $cases : [] as $case) {
            if (is_array($case) && is_string($case['name'] ?? null)) {
                /** @var array<string, mixed> $case */
                $out[$case['name']] = [$case];
            }
        }

        return $out;
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function webhookCases(): array
    {
        return self::cases('webhook-signatures');
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function retryCases(): array
    {
        return self::cases('retries');
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function problemCases(): array
    {
        return self::cases('problems');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('webhookCases')]
    public function testWebhookSignature(array $case): void
    {
        $vectors = self::vectors('webhook-signatures');
        $header = $case['header'];
        $body = $case['body'] ?? $vectors['body'];

        self::assertSame($case['valid'], Webhook::verify(
            (string) $vectors['secret'],
            is_string($header) ? $header : null,
            is_string($body) ? $body : '',
            is_int($vectors['tolerance_seconds']) ? $vectors['tolerance_seconds'] : 300,
            is_int($vectors['now']) ? $vectors['now'] : null,
        ));
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('retryCases')]
    public function testRetries(array $case): void
    {
        /** @var list<array<string, mixed>> $answers */
        $answers = $case['answers'];
        $maxRetries = self::vectors('retries')['max_retries'];
        [$client, $http] = $this->client(
            function (RequestInterface $request, int $n) use ($answers): Response {
                $answer = $answers[$n - 1] ?? throw new \RuntimeException('more requests than answers');
                if (($answer['network_error'] ?? false) === true) {
                    throw new NetworkError($request);
                }
                $headers = ['Content-Type' => 'application/json'];
                if (is_string($answer['retry_after'] ?? null)) {
                    $headers['Retry-After'] = $answer['retry_after'];
                }

                return new Response(
                    is_int($answer['status'] ?? null) ? $answer['status'] : 200,
                    $headers,
                    json_encode($answer['body'] ?? new \stdClass(), JSON_THROW_ON_ERROR),
                );
            },
            is_int($maxRetries) ? $maxRetries : 3,
        );

        try {
            $client->request('GET', '/account');
            $outcome = ['ok' => true];
        } catch (FormfeedException $e) {
            $outcome = ['error' => ['code' => $e->errorCode, 'status' => $e->status]];
        }

        self::assertSame($case['outcome'], $outcome);
        self::assertCount(count($answers), $http->requests);
        /** @var list<array{int|float, int|float}> $bounds */
        $bounds = $case['waits_ms'];
        self::assertCount(count($bounds), $this->waits);
        foreach ($this->waits as $n => $seconds) {
            [$lowest, $highest] = $bounds[$n];
            self::assertGreaterThanOrEqual($lowest, round($seconds * 1000, 6), "wait {$n}");
            self::assertLessThanOrEqual($highest, round($seconds * 1000, 6), "wait {$n}");
        }
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('problemCases')]
    public function testProblem(array $case): void
    {
        $body = $case['body'];
        /** @var array<string, string> $headers */
        $headers = $case['headers'];
        [$client] = $this->client(fn() => match (true) {
            $body === null => new Response((int) $case['status'], $headers),
            is_string($body) => new Response((int) $case['status'], [...$headers, 'Content-Type' => 'text/plain'], $body),
            default => new Response((int) $case['status'], [...$headers, 'Content-Type' => 'application/json'], json_encode($body, JSON_THROW_ON_ERROR)),
        }, maxRetries: 0);

        try {
            $client->request('GET', '/account');
            self::fail('no exception');
        } catch (FormfeedException $e) {
            self::assertSame($case['expect'], [
                'code' => $e->errorCode,
                'message' => $e->getMessage(),
                'status' => $e->status,
                'request_id' => $e->requestId,
            ]);
        }
    }
}
