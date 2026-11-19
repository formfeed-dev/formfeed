<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use Formfeed\Laravel\Facades\Formfeed;
use Formfeed\Laravel\Testing\FormfeedRequest;
use PHPUnit\Framework\AssertionFailedError;

/** Every assertion passes where it should and fails, saying what was sent, where it should not. */
final class FakeAssertionsTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Formfeed::fake();
    }

    public function testRendered(): void
    {
        Formfeed::renders()->create(['template' => 'invoice', 'data' => ['total' => 119]]);
        Formfeed::renders()->create(['template' => 'invoice', 'data' => ['total' => 238]]);

        Formfeed::assertRendered();
        Formfeed::assertRendered('invoice');
        Formfeed::assertRendered('invoice', times: 2);
        Formfeed::assertRendered(static fn(array $body): bool => ($body['data']['total'] ?? null) === 238, times: 1);
        Formfeed::assertRendered(static fn(array $body, FormfeedRequest $request): bool => $request->idempotencyKey() !== null, times: 2);

        $this->fails(static fn() => Formfeed::assertRendered('receipt'), 'A render of template receipt was not asked for. Sent: POST /renders (invoice), POST /renders (invoice).');
        $this->fails(static fn() => Formfeed::assertRendered('invoice', times: 3), 'A render of template invoice was asked for 2 times, not 3 times.');
        $this->fails(static fn() => Formfeed::assertRendered(static fn(): bool => false), 'A render matching the callback was not asked for.');
    }

    public function testNotRendered(): void
    {
        Formfeed::renders()->create(['template' => 'invoice']);

        Formfeed::assertNotRendered('receipt');
        Formfeed::assertNotRendered(static fn(array $body): bool => isset($body['html']));
        $this->fails(static fn() => Formfeed::assertNotRendered('invoice'), 'A render of template invoice was asked for once.');
    }

    public function testNothingRendered(): void
    {
        Formfeed::assertNothingRendered();
        Formfeed::assertNothingSent();

        Formfeed::renders()->create(['html' => '<p>Hi</p>']);
        $this->fails(static fn() => Formfeed::assertNothingRendered(), 'Renders were asked for: POST /renders.');
        $this->fails(static fn() => Formfeed::assertNothingSent(), 'Requests were sent: POST /renders.');
    }

    public function testBatched(): void
    {
        $this->fails(static fn() => Formfeed::assertBatched(), 'A batch was not asked for. Nothing was sent.');

        Formfeed::renders()->batch(['template' => 'certificate', 'items' => [['data' => []]]]);

        Formfeed::assertBatched();
        Formfeed::assertBatched('certificate', times: 1);
        Formfeed::assertNothingRendered();
    }

    public function testSent(): void
    {
        Formfeed::pdf()->merge(['rnd_1', 'rnd_2']);
        $merge = static fn(FormfeedRequest $request): bool => $request->is('POST /pdf/merge');

        Formfeed::assertSent($merge);
        Formfeed::assertSent($merge, times: 1);
        Formfeed::assertSentCount(1);
        Formfeed::assertNotSent(static fn(FormfeedRequest $request): bool => $request->is('/pdf/protect'));

        $this->fails(static fn() => Formfeed::assertNotSent($merge), 'Requests matching the callback were sent: POST /pdf/merge.');
        $this->fails(static fn() => Formfeed::assertSentCount(2), 'Expected 2 requests, the fake answered 1. Sent: POST /pdf/merge.');
    }

    public function testAssertingWithoutAFakeSaysSo(): void
    {
        $this->refreshApplication();

        $this->expectException(\LogicException::class);
        $this->expectExceptionMessage('Formfeed::fake()');
        Formfeed::assertNothingSent();
    }

    private function fails(\Closure $assertion, string $message): void
    {
        try {
            $assertion();
        } catch (AssertionFailedError $e) {
            self::assertStringContainsString($message, $e->getMessage());

            return;
        }
        self::fail("the assertion passed; it should have failed with: {$message}");
    }
}
