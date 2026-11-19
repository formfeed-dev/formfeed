<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use Formfeed\Client;
use Formfeed\Laravel\Facades\Formfeed;

final class FacadeTest extends TestCase
{
    public function testEveryServiceIsTheContainerClients(): void
    {
        $client = $this->resolve(Client::class);

        self::assertSame($client, Formfeed::client());
        self::assertSame($client->renders, Formfeed::renders());
        self::assertSame($client->jobs, Formfeed::jobs());
        self::assertSame($client->pdf, Formfeed::pdf());
        self::assertSame($client->einvoices, Formfeed::einvoices());
        self::assertSame($client->files, Formfeed::files());
        self::assertSame($client->templates, Formfeed::templates());
        self::assertSame($client->webhooks, Formfeed::webhooks());
        self::assertSame($client->account, Formfeed::account());
    }

    public function testTheAliasNeedsNoImport(): void
    {
        $alias = 'Formfeed';
        self::assertTrue(class_exists($alias));
        self::assertSame($this->resolve(Client::class), $alias::client());
    }

    public function testRequestReachesAnyCall(): void
    {
        Formfeed::fake(['GET /templates/invoice/channels' => ['data' => [['name' => 'published', 'version' => 3]]]]);

        self::assertSame(['data' => [['name' => 'published', 'version' => 3]]], Formfeed::request('GET', '/templates/invoice/channels'));
    }

    public function testFakingSwapsTheClientForTheFacadeAndTheContainer(): void
    {
        $real = $this->resolve(Client::class);
        $fake = Formfeed::fake();

        self::assertNotSame($real, Formfeed::client());
        self::assertSame($fake->client(), Formfeed::client());
        self::assertSame($fake->client(), $this->resolve(Client::class));
        self::assertSame($fake->client(), $this->app?->make('formfeed'));
    }
}
