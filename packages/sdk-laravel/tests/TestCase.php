<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use Formfeed\Laravel\Facades\Formfeed;
use Formfeed\Laravel\FormfeedServiceProvider;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Foundation\Application;
use Orchestra\Testbench\TestCase as Testbench;

abstract class TestCase extends Testbench
{
    protected const KEY = 'ff_live_0000000000000000000000000000000000000000000';
    protected const SECRET = 'whsec_mock_secret_123456';

    /**
     * @param Application $app
     *
     * @return list<class-string>
     */
    protected function getPackageProviders($app): array
    {
        return [FormfeedServiceProvider::class];
    }

    /**
     * @param Application $app
     *
     * @return array<string, class-string>
     */
    protected function getPackageAliases($app): array
    {
        return ['Formfeed' => Formfeed::class];
    }

    /** @param Application $app */
    protected function defineEnvironment($app): void
    {
        $config = $app->make(Repository::class);
        $config->set('formfeed.key', self::KEY);
        $config->set('formfeed.webhook_secret', self::SECRET);
    }

    protected function config(): Repository
    {
        return $this->app?->make(Repository::class) ?? throw new \LogicException('no application');
    }

    /**
     * @template T of object
     *
     * @param class-string<T> $class
     *
     * @return T
     */
    protected function resolve(string $class): object
    {
        $app = $this->app ?? throw new \LogicException('no application');
        $resolved = $app->make($class);
        self::assertInstanceOf($class, $resolved);

        return $resolved;
    }
}
