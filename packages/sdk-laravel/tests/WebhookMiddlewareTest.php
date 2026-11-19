<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use Formfeed\Laravel\Testing\FormfeedFake;
use Formfeed\Laravel\Testing\InteractsWithFormfeedWebhooks;
use Illuminate\Http\Request;
use Illuminate\Routing\Router;
use Illuminate\Support\Carbon;
use PHPUnit\Framework\Attributes\DataProvider;

final class WebhookMiddlewareTest extends TestCase
{
    use InteractsWithFormfeedWebhooks;

    /** @var list<array{string, string, bool}> what the route saw */
    private static array $handled = [];

    protected function setUp(): void
    {
        parent::setUp();
        self::$handled = [];
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    /** @param Router $router */
    protected function defineRoutes($router): void
    {
        $router->post('/formfeed/webhook', static function (Request $request) {
            $type = $request->input('type');
            $id = $request->input('data.id');
            self::$handled[] = [is_string($type) ? $type : '', is_string($id) ? $id : '', $request->isJson()];

            return response()->noContent();
        })->middleware('formfeed.webhook');
    }

    public function testASignedDeliveryReachesTheRouteWithItsEvent(): void
    {
        $this->postFormfeedWebhook('/formfeed/webhook', 'render.completed', ['id' => 'rnd_1', 'status' => 'succeeded', 'note' => 'Größe: 3 × ü'])
            ->assertNoContent();

        self::assertSame([['render.completed', 'rnd_1', true]], self::$handled);
    }

    public function testAWrongSecretIsRefused(): void
    {
        $this->postFormfeedWebhook('/formfeed/webhook', 'render.completed', ['id' => 'rnd_1'], secret: 'whsec_another')
            ->assertUnauthorized();

        self::assertSame([], self::$handled);
    }

    public function testADeliveryWithoutASignatureIsRefused(): void
    {
        $this->call('POST', '/formfeed/webhook', [], [], [], ['CONTENT_TYPE' => 'application/json'], '{"type":"render.completed"}')
            ->assertUnauthorized();

        self::assertSame([], self::$handled);
    }

    public function testTheSignatureCoversTheBodyAsItArrived(): void
    {
        $signed = '{"type":"render.completed","data":{"id":"rnd_1"}}';
        $sent = "{\n  \"type\": \"render.completed\",\n  \"data\": { \"id\": \"rnd_1\" }\n}";
        $now = Carbon::now()->getTimestamp();

        $this->call('POST', '/formfeed/webhook', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_WEBHOOK_SIGNATURE' => FormfeedFake::signature(self::SECRET, $signed, $now),
        ], $sent)->assertUnauthorized();
    }

    public function testADeliveryOlderThanTheToleranceIsRefusedOnLaravelsClock(): void
    {
        $body = '{"type":"render.completed","data":{"id":"rnd_1"}}';
        $signedAt = Carbon::now()->getTimestamp();
        $post = fn() => $this->call('POST', '/formfeed/webhook', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_WEBHOOK_SIGNATURE' => FormfeedFake::signature(self::SECRET, $body, $signedAt),
        ], $body);

        $this->travel(299)->seconds();
        $post()->assertNoContent();

        $this->travel(2)->seconds();
        $post()->assertUnauthorized();

        $this->config()->set('formfeed.webhook_tolerance', 600);
        $post()->assertNoContent();
    }

    public function testAMissingSecretIsTheServersError(): void
    {
        $this->config()->set('formfeed.webhook_secret', null);
        $this->withoutExceptionHandling();

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('FORMFEED_WEBHOOK_SECRET');
        $this->call('POST', '/formfeed/webhook', [], [], [], ['CONTENT_TYPE' => 'application/json'], '{}');
    }

    /**
     * The cases every Formfeed SDK checks, through the middleware: a signature is taken from the
     * header as sent, over the body as it arrived.
     *
     * @param array{name: string, header: string|null, body: string|null, valid: bool} $case
     */
    #[DataProvider('vectors')]
    public function testTheSharedSignatureVectors(array $case, string $secret, int $now, int $tolerance, string $body): void
    {
        $this->config()->set('formfeed.webhook_secret', $secret);
        $this->config()->set('formfeed.webhook_tolerance', $tolerance);
        Carbon::setTestNow(Carbon::createFromTimestamp($now));

        $server = ['CONTENT_TYPE' => 'application/json'];
        if ($case['header'] !== null) {
            $server['HTTP_WEBHOOK_SIGNATURE'] = $case['header'];
        }
        $response = $this->call('POST', '/formfeed/webhook', [], [], [], $server, $case['body'] ?? $body);

        self::assertSame($case['valid'] ? 204 : 401, $response->getStatusCode(), $case['name']);
    }

    /** @return iterable<string, array{array{name: string, header: string|null, body: string|null, valid: bool}, string, int, int, string}> */
    public static function vectors(): iterable
    {
        $text = file_get_contents(dirname(__DIR__, 2) . '/api-types/fixtures/sdk/webhook-signatures.json');
        $vectors = is_string($text) ? json_decode($text, true, 512, JSON_THROW_ON_ERROR) : null;
        if (!is_array($vectors) || !is_array($vectors['cases'] ?? null)) {
            throw new \RuntimeException('the vectors live in packages/api-types/fixtures/sdk/webhook-signatures.json');
        }
        foreach ($vectors['cases'] as $case) {
            yield $case['name'] => [$case, $vectors['secret'], $vectors['now'], $vectors['tolerance_seconds'], $vectors['body']];
        }
    }
}
