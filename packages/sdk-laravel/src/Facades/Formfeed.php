<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Facades;

use Formfeed\Client;
use Formfeed\Laravel\Internal\Settings;
use Formfeed\Laravel\Testing\FormfeedFake;
use Formfeed\Laravel\Testing\FormfeedRequest;
use Formfeed\Resources\Account;
use Formfeed\Resources\Einvoices;
use Formfeed\Resources\Files;
use Formfeed\Resources\Jobs;
use Formfeed\Resources\Pdf;
use Formfeed\Resources\Renders;
use Formfeed\Resources\Templates;
use Formfeed\Resources\Webhooks;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Facade;

/**
 * The container's `Formfeed\Client`, its services as methods:
 *
 *     $render = Formfeed::renders()->create(['template' => 'invoice', 'data' => $data]);
 *     Storage::put("invoices/{$order->id}.pdf", Formfeed::renders()->download($render));
 *
 * In a test, `Formfeed::fake()` swaps it for a client that answers without the network and keeps
 * every request for the assertions below.
 *
 * @method static mixed request(string $method, string $path, array<string, mixed>|null $body = null, string|null $idempotencyKey = null)
 *
 * @see Client
 */
final class Formfeed extends Facade
{
    public static function client(): Client
    {
        $client = self::getFacadeRoot();
        if (!$client instanceof Client) {
            throw new \LogicException('the container binds ' . get_debug_type($client) . ' as Formfeed\Client');
        }

        return $client;
    }

    public static function renders(): Renders
    {
        return self::client()->renders;
    }

    public static function jobs(): Jobs
    {
        return self::client()->jobs;
    }

    public static function pdf(): Pdf
    {
        return self::client()->pdf;
    }

    public static function einvoices(): Einvoices
    {
        return self::client()->einvoices;
    }

    public static function files(): Files
    {
        return self::client()->files;
    }

    public static function templates(): Templates
    {
        return self::client()->templates;
    }

    public static function webhooks(): Webhooks
    {
        return self::client()->webhooks;
    }

    public static function account(): Account
    {
        return self::client()->account;
    }

    /**
     * Swaps the client, for the facade and for every class the container makes from now on, for one
     * that answers without the network: renders, batches, jobs and the PDF tools as the API would,
     * with real files behind their links, and anything else from `$answers`. A second call adds its
     * answers before the first's.
     *
     *     Formfeed::fake(['POST /renders' => FormfeedFake::problem('quota_exceeded', 402)]);
     *
     * @param array<string, mixed> $answers by `METHOD /path` (`*` matches anything, `/v1` may be left out)
     */
    public static function fake(array $answers = []): FormfeedFake
    {
        $app = self::getFacadeApplication();
        if ($app === null) {
            throw new \LogicException('Formfeed::fake() needs the application; call it in a Laravel test');
        }
        if ($app->bound(FormfeedFake::class)) {
            return $app->make(FormfeedFake::class)->answer($answers);
        }

        $settings = new Settings($app->make(Repository::class));
        $fake = new FormfeedFake($answers, $settings->region(), $settings->environment());
        self::swap($fake->client());
        $app->instance(FormfeedFake::class, $fake);

        return $fake;
    }

    /**
     * A render was asked for: of the template with that slug or id, or for which the callback, given
     * the request's body and the request, answers true; `$times` exactly so often.
     *
     * @param string|(\Closure(array<string, mixed>, FormfeedRequest): bool)|null $template
     */
    public static function assertRendered(string|\Closure|null $template = null, ?int $times = null): void
    {
        self::faked()->assertRendered($template, $times);
    }

    /** @param string|(\Closure(array<string, mixed>, FormfeedRequest): bool) $template */
    public static function assertNotRendered(string|\Closure $template): void
    {
        self::faked()->assertNotRendered($template);
    }

    public static function assertNothingRendered(): void
    {
        self::faked()->assertNothingRendered();
    }

    /**
     * A batch was queued, of the template or matching the callback, like `assertRendered`.
     *
     * @param string|(\Closure(array<string, mixed>, FormfeedRequest): bool)|null $template
     */
    public static function assertBatched(string|\Closure|null $template = null, ?int $times = null): void
    {
        self::faked()->assertBatched($template, $times);
    }

    /** @param \Closure(FormfeedRequest): bool $callback */
    public static function assertSent(\Closure $callback, ?int $times = null): void
    {
        self::faked()->assertSent($callback, $times);
    }

    /** @param \Closure(FormfeedRequest): bool $callback */
    public static function assertNotSent(\Closure $callback): void
    {
        self::faked()->assertNotSent($callback);
    }

    public static function assertNothingSent(): void
    {
        self::faked()->assertNothingSent();
    }

    public static function assertSentCount(int $count): void
    {
        self::faked()->assertSentCount($count);
    }

    /**
     * The requests the fake answered, in order, those the callback accepts.
     *
     * @param (\Closure(FormfeedRequest): bool)|null $filter
     *
     * @return Collection<int, FormfeedRequest>
     */
    public static function recorded(?\Closure $filter = null): Collection
    {
        return self::faked()->recorded($filter);
    }

    protected static function getFacadeAccessor(): string
    {
        return Client::class;
    }

    private static function faked(): FormfeedFake
    {
        $app = self::getFacadeApplication();
        $fake = $app !== null && $app->bound(FormfeedFake::class) ? $app->make(FormfeedFake::class) : null;
        if (!$fake instanceof FormfeedFake) {
            throw new \LogicException('call Formfeed::fake() before asserting on what was sent');
        }

        return $fake;
    }
}
