<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use Formfeed\Client;
use Formfeed\FormfeedException;
use Formfeed\Laravel\Facades\Formfeed;
use Formfeed\Laravel\FormfeedServiceProvider;
use Formfeed\Laravel\Http\Middleware\VerifyWebhookSignature;
use Illuminate\Routing\Router;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\ServiceProvider;
use PHPUnit\Framework\Attributes\DataProvider;

final class ServiceProviderTest extends TestCase
{
    public function testTheDefaultsAreMergedUnderTheApplicationsSettings(): void
    {
        self::assertSame(self::KEY, $this->config()->get('formfeed.key'));
        self::assertSame('eu', $this->config()->get('formfeed.region'));
        self::assertNull($this->config()->get('formfeed.base_url'));
        self::assertSame(300, $this->config()->get('formfeed.webhook_tolerance'));
        self::assertSame(3, $this->config()->get('formfeed.max_retries'));
        self::assertSame(120, $this->config()->get('formfeed.timeout'));
    }

    public function testTheContainerHoldsOneClientUnderTwoNames(): void
    {
        $client = $this->resolve(Client::class);

        self::assertSame($client, $this->resolve(Client::class));
        self::assertSame($client, $this->app?->make('formfeed'));
        self::assertSame($client, Formfeed::client());
    }

    public function testAMissingKeySaysWhereItGoes(): void
    {
        $this->config()->set('formfeed.key', '');

        $thrown = null;
        try {
            $this->app?->make(Client::class);
        } catch (\Throwable $e) {
            $thrown = $e;
        }
        if (!$thrown instanceof FormfeedException) {
            self::fail('expected a FormfeedException, got ' . get_debug_type($thrown));
        }
        self::assertSame('invalid_request', $thrown->errorCode);
        self::assertStringContainsString('FORMFEED_API_KEY', $thrown->getMessage());
    }

    #[DataProvider('wrongSettings')]
    public function testASettingOfTheWrongKindIsNamed(string $name, mixed $value): void
    {
        $this->config()->set("formfeed.{$name}", $value);

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage("formfeed.{$name}");
        $this->app?->make(Client::class);
    }

    /** @return iterable<string, array{string, mixed}> */
    public static function wrongSettings(): iterable
    {
        yield 'retries as a word' => ['max_retries', 'often'];
        yield 'retries below zero' => ['max_retries', -1];
        yield 'no time at all' => ['timeout', 0];
        yield 'time as a word' => ['timeout', 'long'];
        yield 'a region that is no text' => ['region', ['eu']];
    }

    public function testValuesFromEnvArriveAsText(): void
    {
        // .env gives strings, an empty one for a line without a value
        $this->config()->set('formfeed.max_retries', '0');
        $this->config()->set('formfeed.timeout', '30');
        $this->config()->set('formfeed.base_url', '');

        self::assertInstanceOf(Client::class, $this->app?->make(Client::class));
    }

    public function testTheWebhookMiddlewareHasItsName(): void
    {
        self::assertSame(VerifyWebhookSignature::class, $this->resolve(Router::class)->getMiddleware()['formfeed.webhook'] ?? null);
    }

    public function testTheConfigurationCanBePublished(): void
    {
        $paths = ServiceProvider::pathsToPublish(FormfeedServiceProvider::class, 'formfeed-config');

        self::assertCount(1, $paths);
        $source = (string) array_key_first($paths);
        self::assertFileExists($source);
        self::assertSame($this->app?->configPath('formfeed.php'), $paths[$source]);
    }

    public function testAboutShowsWhatArrivedButNeverTheKeyOrTheSecret(): void
    {
        Artisan::call('about', ['--only' => 'formfeed', '--json' => true]);
        $output = Artisan::output();
        $about = json_decode($output, true, 512, JSON_THROW_ON_ERROR);

        self::assertIsArray($about);
        self::assertSame([
            'sdk' => Client::VERSION,
            'api' => 'eu',
            'api_key' => 'ff_live_…',
            'webhook_secret' => 'set',
        ], $about['formfeed'] ?? null);
        self::assertStringNotContainsString(self::KEY, $output);
        self::assertStringNotContainsString(self::SECRET, $output);
    }
}
