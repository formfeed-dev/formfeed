<?php

declare(strict_types=1);

namespace Formfeed\Laravel;

use Formfeed\Client;
use Formfeed\Laravel\Http\Middleware\VerifyWebhookSignature;
use Formfeed\Laravel\Internal\Settings;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Foundation\Console\AboutCommand;
use Illuminate\Routing\Router;
use Illuminate\Support\ServiceProvider;

/**
 * Binds `Formfeed\Client` in the container from config/formfeed.php (one client for the application,
 * made when it is first asked for), names the webhook middleware `formfeed.webhook`, and offers the
 * configuration to `php artisan vendor:publish --tag=formfeed-config`.
 */
final class FormfeedServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/formfeed.php', 'formfeed');

        $this->app->singleton(
            Client::class,
            static fn(Application $app): Client => (new Settings($app->make(Repository::class)))->client(),
        );
        $this->app->alias(Client::class, 'formfeed');
    }

    public function boot(): void
    {
        $this->app->make(Router::class)->aliasMiddleware('formfeed.webhook', VerifyWebhookSignature::class);

        if (!$this->app->runningInConsole()) {
            return;
        }
        $this->publishes(
            [__DIR__ . '/../config/formfeed.php' => $this->app->configPath('formfeed.php')],
            'formfeed-config',
        );
        // `php artisan about` shows whether the settings arrived, never the key or the secret
        if (class_exists(AboutCommand::class)) {
            AboutCommand::add('Formfeed', function (): array {
                $settings = new Settings($this->app->make(Repository::class));
                $key = $settings->key();

                return [
                    'SDK' => Client::VERSION,
                    'API' => $settings->baseUrl() ?? $settings->region(),
                    'API key' => $key === null ? 'not set' : ($settings->environment() === 'test' ? 'ff_test_…' : 'ff_live_…'),
                    'Webhook secret' => $settings->webhookSecret() === null ? 'not set' : 'set',
                ];
            });
        }
    }
}
