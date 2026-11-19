<?php

declare(strict_types=1);

namespace Formfeed\Tests;

use Formfeed\Client;
use Formfeed\FormfeedException;
use Formfeed\Models\Render;
use Formfeed\Tests\Support\ClientTestCase;
use Formfeed\Upload;
use Nyholm\Psr7\Response;
use Psr\Http\Message\RequestInterface;

final class ClientTest extends ClientTestCase
{
    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';

    public function testARenderSendsTheKeyAnIdempotencyKeyAndJson(): void
    {
        [$client, $http] = $this->client(fn() => self::json(self::RENDER, 201));

        $render = $client->renders->create(['template' => 'invoice', 'data' => ['a' => 1], 'output' => 'pdf']);

        self::assertSame('rnd_1', $render->id);
        self::assertTrue($render->finished());
        self::assertSame(1, $render->pageCount);
        self::assertSame('invoice', $render->template['slug'] ?? null);
        $request = $http->request(0);
        self::assertSame('POST', $request->getMethod());
        self::assertSame('https://api-eu.formfeed.dev/v1/renders', (string) $request->getUri());
        self::assertSame('Bearer ff_test_k', $request->getHeaderLine('Authorization'));
        self::assertSame('formfeed-sdk-php/0.3', $request->getHeaderLine('User-Agent'));
        self::assertSame('application/json', $request->getHeaderLine('Content-Type'));
        self::assertMatchesRegularExpression(self::UUID, $request->getHeaderLine('Idempotency-Key'));
        self::assertSame(['template' => 'invoice', 'data' => ['a' => 1], 'output' => 'pdf'], self::body($request));
    }

    public function testEmptyDataIsSentAsAnObject(): void
    {
        [$client, $http] = $this->client(fn() => self::json(self::RENDER, 201));

        $client->renders->create(['template' => 'invoice', 'data' => []]);

        self::assertSame('{"template":"invoice","data":{}}', (string) $http->request(0)->getBody());
    }

    public function testAGivenIdempotencyKeyIsSentAsItIs(): void
    {
        [$client, $http] = $this->client(fn() => self::json(self::RENDER, 201));

        $client->renders->create(['html' => '<p>x</p>'], 'order-1234');

        self::assertSame('order-1234', $http->request(0)->getHeaderLine('Idempotency-Key'));
    }

    public function testTheRegionOrABaseUrlNamesTheHost(): void
    {
        [$us, $http] = $this->client(fn() => self::json(self::RENDER), region: 'us');
        $us->renders->get('rnd_1');
        self::assertSame('https://api-us.formfeed.dev/v1/renders/rnd_1', (string) $http->request(0)->getUri());

        [$local, $http] = $this->client(fn() => self::json(self::RENDER), baseUrl: 'http://localhost:8787/v1/');
        $local->renders->get('rnd_1');
        self::assertSame('http://localhost:8787/v1/renders/rnd_1', (string) $http->request(0)->getUri());
    }

    public function testAnUnknownRegionIsRefused(): void
    {
        $this->expectException(FormfeedException::class);
        $this->expectExceptionMessage('unknown region');
        $this->client(fn() => self::json([]), region: 'ap');
    }

    public function testAProblemBecomesOneException(): void
    {
        [$client] = $this->client(fn() => self::json(
            ['type' => 'https://docs.formfeed.dev/errors/quota-exceeded', 'title' => 'Quota exceeded', 'status' => 402, 'detail' => 'The period has no units left.', 'code' => 'quota_exceeded'],
            402,
            ['X-Request-Id' => 'req_9'],
        ));

        try {
            $client->renders->create(['template' => 'invoice']);
            self::fail('no exception');
        } catch (FormfeedException $e) {
            self::assertSame('quota_exceeded', $e->errorCode);
            self::assertSame('The period has no units left.', $e->getMessage());
            self::assertSame(402, $e->status);
            self::assertSame('req_9', $e->requestId);
            self::assertSame('Quota exceeded', $e->problem['title'] ?? null);
        }
    }

    public function testARetrySendsTheSameIdempotencyKey(): void
    {
        [$client, $http] = $this->client(fn(RequestInterface $r, int $n) => $n === 1
            ? self::json(['code' => 'rate_limited'], 429, ['Retry-After' => '1'])
            : self::json(self::RENDER, 201));

        $client->renders->create(['template' => 'invoice']);

        self::assertCount(2, $http->requests);
        self::assertSame($http->request(0)->getHeaderLine('Idempotency-Key'), $http->request(1)->getHeaderLine('Idempotency-Key'));
        self::assertCount(1, $this->waits);
        self::assertGreaterThanOrEqual(1.0, $this->waits[0]);
        self::assertLessThanOrEqual(1.25, $this->waits[0]);
    }

    public function testWaitForPollsUntilTheRenderIsFinished(): void
    {
        [$client, $http] = $this->client(fn(RequestInterface $r, int $n) => self::json(
            $n < 3 ? ['id' => 'rnd_1', 'status' => 'processing'] : self::RENDER,
        ));

        $render = $client->renders->waitFor('rnd_1');

        self::assertSame('succeeded', $render->status);
        self::assertCount(3, $http->requests);
        self::assertSame([1.0, 1.0], $this->waits);
    }

    public function testWaitForEndsAtItsTimeout(): void
    {
        [$client, $http] = $this->client(fn() => self::json(['id' => 'rnd_1', 'status' => 'queued']));

        try {
            $client->renders->waitFor('rnd_1', timeout: 3, interval: 1);
            self::fail('no exception');
        } catch (FormfeedException $e) {
            self::assertSame('timeout', $e->errorCode);
        }
        self::assertSame([1.0, 1.0, 1.0], $this->waits);
        self::assertCount(4, $http->requests);
    }

    public function testADownloadFollowsTheSignedLinkWithoutTheKey(): void
    {
        [$client, $http] = $this->client(fn() => new Response(200, ['Content-Type' => 'application/pdf'], '%PDF-1.7'));

        $bytes = $client->renders->download(Render::fromArray(self::RENDER));

        self::assertSame('%PDF-1.7', $bytes);
        self::assertSame(self::RENDER['download_url'], (string) $http->request(0)->getUri());
        self::assertFalse($http->request(0)->hasHeader('Authorization'));
    }

    public function testARenderWithoutOutputIsNotReady(): void
    {
        [$client] = $this->client(fn() => self::json([]));

        $this->expectException(FormfeedException::class);
        $client->renders->download(Render::fromArray(['id' => 'rnd_2', 'status' => 'queued', 'download_url' => null]));
    }

    public function testAllFollowsTheCursor(): void
    {
        [$client, $http] = $this->client(fn(RequestInterface $r, int $n) => self::json($n === 1
            ? ['data' => [self::RENDER, [...self::RENDER, 'id' => 'rnd_2']], 'next_cursor' => 'c2']
            : ['data' => [[...self::RENDER, 'id' => 'rnd_3']], 'next_cursor' => null]));

        $ids = array_map(fn(Render $render) => $render->id, iterator_to_array($client->renders->all(['status' => 'failed'])));

        self::assertSame(['rnd_1', 'rnd_2', 'rnd_3'], $ids);
        self::assertSame('https://api-eu.formfeed.dev/v1/renders?status=failed', (string) $http->request(0)->getUri());
        self::assertSame('https://api-eu.formfeed.dev/v1/renders?status=failed&cursor=c2', (string) $http->request(1)->getUri());
    }

    public function testAnUploadGoesAsMultipartBesideTheOptions(): void
    {
        [$client, $http] = $this->client(fn() => self::json(self::RENDER));

        $client->pdf->redact(Upload::fromString('%PDF-1.7 bytes', 'contract.pdf'), [
            'regions' => [['page' => 1, 'x' => 10, 'y' => 20, 'width' => 100, 'height' => 12]],
            'fill' => null,
            'flatten' => true,
            'expires_in' => null,
        ]);

        $request = $http->request(0);
        self::assertSame('https://api-eu.formfeed.dev/v1/pdf/redact', (string) $request->getUri());
        self::assertMatchesRegularExpression(self::UUID, $request->getHeaderLine('Idempotency-Key'));
        self::assertSame([
            'file' => ['contract.pdf', 'application/pdf', '%PDF-1.7 bytes'],
            'regions' => '[{"page":1,"x":10,"y":20,"width":100,"height":12}]',
            'fill' => 'null',
            'flatten' => 'true',
        ], self::parts($request));
    }

    public function testAStoredSourceGoesAsJson(): void
    {
        [$client, $http] = $this->client(fn() => self::json(['source' => 'rnd_9', 'page_count' => 2, 'pages' => [], 'encrypted' => false, 'metadata' => []]));

        $info = $client->pdf->info('rnd_9');
        $client->pdf->compress(Render::fromArray(self::RENDER), ['filename' => 'small']);

        self::assertSame(2, $info->pageCount);
        self::assertSame(['source' => 'rnd_9'], self::body($http->request(0)));
        self::assertFalse($http->request(0)->hasHeader('Idempotency-Key'));
        self::assertSame(['filename' => 'small', 'source' => 'rnd_1'], self::body($http->request(1)));
        self::assertTrue($http->request(1)->hasHeader('Idempotency-Key'));
    }

    public function testAMergeTakesRendersAndLibraryFiles(): void
    {
        [$client, $http] = $this->client(fn() => self::json(self::RENDER));

        $client->pdf->merge([Render::fromArray(self::RENDER), 'fil_2', 'terms.pdf'], ['filename' => 'contract']);

        self::assertSame(['filename' => 'contract', 'sources' => ['rnd_1', 'fil_2', 'terms.pdf']], self::body($http->request(0)));
    }

    public function testALibraryUploadNamesTheFile(): void
    {
        [$client, $http] = $this->client(fn() => self::json(['id' => 'fil_1', 'name' => 'logo.png', 'content_type' => 'image/png', 'bytes' => 4, 'sha256' => 'ab', 'url' => 'https://cdn.formfeed.test/a/logo.png', 'created_at' => 'x', 'updated_at' => 'y'], 201));

        $file = $client->files->upload(Upload::fromString("\x89PNG", 'logo.png'));

        self::assertSame('fil_1', $file->id);
        self::assertSame(['file' => ['logo.png', 'image/png', "\x89PNG"], 'name' => 'logo.png'], self::parts($http->request(0)));
    }

    public function testAnEinvoiceIsValidatedByItsRender(): void
    {
        [$client, $http] = $this->client(fn() => self::json(['valid' => true]));

        $report = $client->einvoices->validate('rnd_1', 'xrechnung');

        self::assertTrue($report['valid']);
        self::assertSame(['render_id' => 'rnd_1', 'rules' => 'xrechnung'], self::body($http->request(0)));
    }

    public function testADeletionAnswersNothing(): void
    {
        [$client, $http] = $this->client(fn() => new Response(204));

        $client->files->delete('fil_1');

        self::assertSame('DELETE', $http->request(0)->getMethod());
        self::assertSame('https://api-eu.formfeed.dev/v1/files/fil_1', (string) $http->request(0)->getUri());
    }

    public function testWebhookEndpointsAreListed(): void
    {
        [$client] = $this->client(fn() => self::json(['data' => [['id' => 'whk_1', 'url' => 'https://example.test/hook', 'events' => ['render.completed'], 'enabled' => true]]]));

        $endpoints = $client->webhooks->list();

        self::assertCount(1, $endpoints);
        self::assertSame(['render.completed'], $endpoints[0]->events);
    }

    public function testATemplateSchemaNamesItsVersion(): void
    {
        [$client, $http] = $this->client(fn() => self::json(['type' => 'object']));

        $client->templates->schema('invoice', 'staging');

        self::assertSame('https://api-eu.formfeed.dev/v1/templates/invoice/schema?version=staging', (string) $http->request(0)->getUri());
    }

    public function testRequestReachesACallWithoutAMethod(): void
    {
        [$client, $http] = $this->client(fn() => self::json(['name' => 'Fennlor Studio GmbH']));

        $brand = $client->request('GET', '/brand');

        self::assertSame(['name' => 'Fennlor Studio GmbH'], $brand);
        self::assertSame('https://api-eu.formfeed.dev/v1/brand', (string) $http->request(0)->getUri());
    }

    /** One version for every package (plan 34, decision 6): the release bumps this one too. */
    public function testTheVersionIsTheReleasesOne(): void
    {
        $publish = dirname(__DIR__, 3) . '/tools/publish/packages.mjs';
        if (!is_file($publish)) {
            self::markTestSkipped('outside the Formfeed repository, which holds the release version');
        }
        self::assertStringContainsString("export const VERSION = '" . Client::VERSION . "';", (string) file_get_contents($publish));
    }
}
