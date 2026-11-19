<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use Formfeed\Client;
use Formfeed\FormfeedException;
use Formfeed\Laravel\Facades\Formfeed;
use Formfeed\Laravel\Testing\FormfeedFake;
use Formfeed\Laravel\Testing\FormfeedRequest;
use Formfeed\Upload;
use Illuminate\Routing\Router;
use Illuminate\Support\Carbon;

final class FakeTest extends TestCase
{
    /** @param Router $router */
    protected function defineRoutes($router): void
    {
        // an application's own code: the client comes from the container
        $router->post('/orders/{order}/invoice', static function (string $order, Client $formfeed) {
            $render = $formfeed->renders->create([
                'template' => 'invoice',
                'data' => ['number' => "RE-{$order}", 'customer' => ['name' => 'Olvarest GmbH']],
                'meta' => ['order_id' => $order],
            ]);

            return response($formfeed->renders->download($render), 200, ['Content-Type' => 'application/pdf']);
        });
    }

    public function testASyncRenderIsFinishedWithARealPdfBehindItsLink(): void
    {
        Formfeed::fake();

        $render = Formfeed::renders()->create(['template' => 'invoice', 'data' => ['total' => 1428.0], 'meta' => ['order_id' => '8812']]);

        self::assertSame('rnd_00000000000000000000000000000001', $render->id);
        self::assertSame('succeeded', $render->status);
        self::assertSame('pdf', $render->output);
        self::assertSame(1, $render->pageCount);
        self::assertSame('live', $render->environment);
        self::assertSame(1.0, $render->units);
        self::assertSame(['order_id' => '8812'], $render->meta);
        self::assertSame('invoice', $render->template['slug'] ?? null);
        self::assertSame('published', $render->template['channel'] ?? null);
        self::assertMatchesRegularExpression('/^tpl_[0-9a-f]{32}$/', (string) ($render->template['id'] ?? ''));
        self::assertNotNull($render->downloadUrl);
        self::assertStringStartsWith('https://files.formfeed.test/', $render->downloadUrl);

        $pdf = Formfeed::renders()->download($render);
        self::assertStringStartsWith('%PDF-1.7', $pdf);
        self::assertSame($render->bytes, strlen($pdf));
        self::assertSame($render->outputSha256, hash('sha256', $pdf));
    }

    public function testATestKeyMakesTestRendersThatCostNothing(): void
    {
        $this->config()->set('formfeed.key', 'ff_test_' . str_repeat('1', 43));
        Formfeed::fake();

        $render = Formfeed::renders()->create(['html' => '<h1>Hi</h1>']);

        self::assertSame('test', $render->environment);
        self::assertSame(0.0, $render->units);
        self::assertNull($render->template);
    }

    public function testTheFakeNeedsNoKey(): void
    {
        $this->config()->set('formfeed.key', null);
        Formfeed::fake();

        self::assertSame('succeeded', Formfeed::renders()->create(['url' => 'https://fennlor.example'])->status);
    }

    public function testAnAsyncRenderIsQueuedUntilItIsRead(): void
    {
        Formfeed::fake();

        $queued = Formfeed::renders()->create(['template' => 'report', 'mode' => 'async']);
        self::assertSame('queued', $queued->status);
        self::assertNull($queued->downloadUrl);

        $done = Formfeed::renders()->waitFor($queued);
        self::assertSame('succeeded', $done->status);
        self::assertSame($queued->id, $done->id);
        self::assertStringStartsWith('%PDF', Formfeed::renders()->download($done));
    }

    public function testTheApplicationsInjectedClientIsTheFake(): void
    {
        Formfeed::fake();

        $response = $this->post('/orders/8812/invoice');

        $response->assertOk();
        self::assertStringStartsWith('%PDF', (string) $response->getContent());
        Formfeed::assertRendered('invoice');
        Formfeed::assertRendered(static fn(array $body): bool => ($body['data']['number'] ?? null) === 'RE-8812', times: 1);
        Formfeed::assertNotRendered('welcome');
        Formfeed::assertSentCount(1);
    }

    public function testAnArrayIsPutOverTheFakesAnswerAndKept(): void
    {
        Formfeed::fake(['POST /renders' => ['page_count' => 3]]);

        $render = Formfeed::renders()->create(['template' => 'report']);
        self::assertSame(3, $render->pageCount);
        self::assertSame(3, substr_count(Formfeed::renders()->download($render), '/Type /Page '));
        self::assertSame(3, Formfeed::renders()->get($render->id)->pageCount);
        self::assertSame(3, Formfeed::pdf()->info($render)->pageCount);
    }

    public function testAProblemIsThrownAsTheSdkThrowsIt(): void
    {
        Formfeed::fake(['POST /v1/renders' => FormfeedFake::problem('quota_exceeded', 402, 'The plan has no units left')]);

        try {
            Formfeed::renders()->create(['template' => 'invoice']);
            self::fail('a problem');
        } catch (FormfeedException $e) {
            self::assertSame('quota_exceeded', $e->errorCode);
            self::assertSame(402, $e->status);
            self::assertSame('The plan has no units left', $e->getMessage());
            self::assertSame('req_fake', $e->requestId);
            self::assertSame('https://docs.formfeed.dev/errors/quota-exceeded', $e->problem['type'] ?? null);
        }
    }

    public function testAnAsyncRenderCanFailWhenItIsRead(): void
    {
        Formfeed::fake(['GET /renders/*' => FormfeedFake::failed('render_timeout', 'Render exceeded 30000 ms')]);

        $render = Formfeed::renders()->waitFor(Formfeed::renders()->create(['template' => 'report', 'mode' => 'async']));

        self::assertSame('failed', $render->status);
        self::assertNull($render->downloadUrl);
        self::assertSame(['code' => 'render_timeout', 'message' => 'Render exceeded 30000 ms'], $render->error);
    }

    public function testASequenceAnswersInTurnAndThenLeavesItToTheFake(): void
    {
        Formfeed::fake(['POST /renders' => FormfeedFake::sequence(
            FormfeedFake::problem('rate_limited', 429),
            ['page_count' => 2],
        )]);

        try {
            Formfeed::renders()->create(['template' => 'invoice']);
            self::fail('the first answer is a problem');
        } catch (FormfeedException $e) {
            self::assertSame('rate_limited', $e->errorCode);
        }
        self::assertSame(2, Formfeed::renders()->create(['template' => 'invoice'])->pageCount);
        self::assertSame(1, Formfeed::renders()->create(['template' => 'invoice'])->pageCount);
        Formfeed::assertRendered('invoice', times: 3);
    }

    public function testAClosureDecidesPerRequestAndNullLeavesItToTheFake(): void
    {
        Formfeed::fake(['POST /renders' => static fn(FormfeedRequest $request) => $request->input('template') === 'broken'
            ? FormfeedFake::problem('template_runtime_error', 422, "'customer' is undefined")
            : null]);

        self::assertSame('succeeded', Formfeed::renders()->create(['template' => 'invoice'])->status);
        $this->expectException(FormfeedException::class);
        $this->expectExceptionMessage("'customer' is undefined");
        Formfeed::renders()->create(['template' => 'broken']);
    }

    public function testALaterCallAddsItsAnswersBeforeTheEarlierOnes(): void
    {
        $fake = Formfeed::fake(['POST /renders' => ['page_count' => 2]]);
        $again = Formfeed::fake(['POST /renders' => ['page_count' => 4]]);

        self::assertSame($fake, $again);
        self::assertSame(4, Formfeed::renders()->create(['template' => 'invoice'])->pageCount);
    }

    public function testACallTheFakeDoesNotAnswerNeedsAnAnswer(): void
    {
        Formfeed::fake();

        try {
            Formfeed::account()->get();
            self::fail('no answer');
        } catch (\LogicException $e) {
            self::assertStringContainsString('GET /account', $e->getMessage());
            self::assertStringContainsString("Formfeed::fake(['GET /account' => [...]])", $e->getMessage());
        }

        Formfeed::fake(['GET /account' => ['id' => 'org_1', 'name' => 'Fennlor Studio GmbH']]);
        self::assertSame('Fennlor Studio GmbH', Formfeed::account()->get()['name'] ?? null);
        $account = Formfeed::request('GET', '/account');
        self::assertIsArray($account);
        self::assertSame('org_1', $account['id'] ?? null);
    }

    public function testABatchIsQueuedAndItsJobFinishesWhenRead(): void
    {
        Formfeed::fake();

        $job = Formfeed::renders()->batch([
            'template' => 'certificate',
            'zip' => true,
            'items' => [
                ['data' => ['name' => 'Max Mustermann']],
                ['data' => ['name' => 'Erika Mustermann'], 'output' => 'png'],
            ],
        ]);
        self::assertSame('job_00000000000000000000000000000001', $job->id);
        self::assertSame('queued', $job->status);
        self::assertSame(2, $job->total);
        self::assertCount(2, $job->items);

        $done = Formfeed::jobs()->waitFor($job);
        self::assertSame('completed', $done->status);
        self::assertSame(2, $done->succeeded);
        self::assertSame(['pdf', 'png'], array_map(static fn($render): string => $render->output, $done->items));
        self::assertSame('certificate', $done->items[1]->template['slug'] ?? null);
        self::assertNotNull($done->zipUrl);
        self::assertSame('succeeded', Formfeed::renders()->get($done->items[0]->id)->status);
        Formfeed::assertBatched('certificate');
        Formfeed::assertNothingRendered();
    }

    public function testAFailedItemMakesAPartlyFailedJob(): void
    {
        Formfeed::fake(['GET /renders/rnd_00000000000000000000000000000002' => FormfeedFake::failed()]);

        $job = Formfeed::renders()->batch(['template' => 'certificate', 'items' => [['data' => []], ['data' => []]]]);
        Formfeed::renders()->get('rnd_00000000000000000000000000000002');

        $done = Formfeed::jobs()->get($job);
        self::assertSame('partially_failed', $done->status);
        self::assertSame([1, 1], [$done->succeeded, $done->failed]);
        self::assertNull($done->zipUrl);
    }

    public function testThePdfToolsAnswerRenders(): void
    {
        Formfeed::fake();
        $invoice = Formfeed::renders()->create(['template' => 'invoice']);

        $merged = Formfeed::pdf()->merge([$invoice, 'terms.pdf']);
        self::assertSame('pdf', $merged->output);
        self::assertSame(0.5, $merged->units);
        self::assertNull($merged->template);

        self::assertSame('zip', Formfeed::pdf()->split(Upload::fromString('%PDF-1.7', 'contract.pdf'), ['every' => 1])->output);
        self::assertSame('jpg', Formfeed::pdf()->toImage($invoice, ['format' => 'jpg'])->output);
        self::assertSame(1.0, Formfeed::pdf()->toImage($invoice)->units);
        self::assertSame('pdf', Formfeed::pdf()->fill(Upload::fromString('%PDF-1.7', 'form.pdf'), ['fields' => ['name' => 'Max Mustermann']])->output);

        $info = Formfeed::pdf()->info(Upload::fromString('%PDF-1.7', 'form.pdf'));
        self::assertSame('form.pdf', $info->source);
        self::assertFalse($info->encrypted);

        Formfeed::assertSent(static fn(FormfeedRequest $request): bool => $request->is('POST /pdf/merge')
            && $request->input('sources') === [$invoice->id, 'terms.pdf']);
        Formfeed::assertSent(static fn(FormfeedRequest $request): bool => $request->is('POST /pdf/fill')
            && $request->file?->name === 'form.pdf'
            && $request->input('fields.name') === 'Max Mustermann');
    }

    public function testTheRendersItMadeCanBeListedReadBackAndDeleted(): void
    {
        Formfeed::fake();
        $first = Formfeed::renders()->create(['template' => 'invoice', 'data' => ['n' => 1], 'post' => ['password' => 'secret']]);
        $second = Formfeed::renders()->create(['template' => 'report']);

        self::assertSame([$second->id, $first->id], array_map(static fn($render): string => $render->id, Formfeed::renders()->list()->data));
        self::assertSame([$first->id], array_map(static fn($render): string => $render->id, iterator_to_array(Formfeed::renders()->all(['template' => 'invoice']), false)));

        $input = Formfeed::renders()->input($first);
        self::assertSame(['n' => 1], $input->data);
        self::assertSame('invoice', $input->template['slug'] ?? null);
        self::assertSame([], $input->post ?? []);

        Formfeed::renders()->deleteOutputs($first);
        self::assertNull(Formfeed::renders()->get($first->id)->downloadUrl);

        try {
            Formfeed::renders()->get('rnd_unknown');
            self::fail('an unknown render');
        } catch (FormfeedException $e) {
            self::assertSame([404, 'not_found'], [$e->status, $e->errorCode]);
        }
    }

    public function testTimesFollowLaravelsClock(): void
    {
        Carbon::setTestNow('2026-11-18 10:00:00');
        Formfeed::fake();

        $render = Formfeed::renders()->create(['template' => 'invoice']);

        self::assertSame('2026-11-18T10:00:00Z', $render->createdAt);
        self::assertSame('2026-11-25T10:00:00Z', $render->expiresAt);
        Carbon::setTestNow();
    }

    public function testARequestIsReadBack(): void
    {
        Formfeed::fake();
        Formfeed::renders()->create(['template' => 'invoice', 'data' => ['customer' => ['name' => 'Olvarest GmbH']]], 'order-8812');
        Formfeed::pdf()->compress(Upload::fromString('%PDF-1.7', 'scan.pdf'), ['level' => 'strong', 'pages' => [1, 2]]);

        [$render, $compress] = Formfeed::recorded()->all();
        self::assertSame('POST', $render->method);
        self::assertSame('/renders', $render->path);
        self::assertSame('Olvarest GmbH', $render->input('data.customer.name'));
        self::assertSame('order-8812', $render->idempotencyKey());
        self::assertSame('Bearer ff_test_fake', $render->header('Authorization'));
        self::assertSame('POST /renders', (string) $render);

        self::assertSame('/pdf/compress', $compress->path);
        self::assertSame('strong', $compress->input('level'));
        self::assertSame([1, 2], $compress->input('pages'));
        self::assertSame(['scan.pdf', 'application/pdf', '%PDF-1.7'], [$compress->file?->name, $compress->file?->contentType, $compress->file?->contents]);
        self::assertCount(1, Formfeed::recorded(static fn(FormfeedRequest $request): bool => $request->is('/pdf/*')));
    }

    public function testFakingTwiceInOneTestKeepsWhatWasSent(): void
    {
        Formfeed::fake();
        Formfeed::renders()->create(['template' => 'invoice']);
        Formfeed::fake();

        Formfeed::assertRendered('invoice');
    }

    public function testAnAnswerThatIsNoAnswerIsRefusedAtOnce(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('POST /renders');
        Formfeed::fake(['POST /renders' => 'done']);
    }
}
