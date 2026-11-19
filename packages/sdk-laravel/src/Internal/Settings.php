<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Internal;

use Formfeed\Client;
use Formfeed\FormfeedException;
use Illuminate\Contracts\Config\Repository;

/**
 * Reads config/formfeed.php. Values from .env arrive as strings, an empty one as '', so every read
 * says what it got wrong instead of failing later in the SDK.
 *
 * @internal
 */
final class Settings
{
    public function __construct(private readonly Repository $config) {}

    /** The client the container binds. */
    public function client(): Client
    {
        $key = $this->key();
        if ($key === null) {
            throw new FormfeedException(
                'invalid_request',
                'The Formfeed API key is not set: add FORMFEED_API_KEY to .env, which config/formfeed.php reads',
            );
        }

        return new Client(
            apiKey: $key,
            region: $this->region(),
            baseUrl: $this->string('base_url'),
            maxRetries: $this->int('max_retries', 3),
            timeout: $this->float('timeout', 120.0),
        );
    }

    public function key(): ?string
    {
        return $this->string('key');
    }

    public function region(): string
    {
        return $this->string('region') ?? 'eu';
    }

    public function baseUrl(): ?string
    {
        return $this->string('base_url');
    }

    public function webhookSecret(): ?string
    {
        return $this->string('webhook_secret');
    }

    public function webhookTolerance(): int
    {
        return $this->int('webhook_tolerance', 300);
    }

    /** `live` or `test`, as the key's prefix says; live when there is none, as in tests with a fake. */
    public function environment(): string
    {
        return str_starts_with($this->key() ?? '', 'ff_test_') ? 'test' : 'live';
    }

    private function string(string $name): ?string
    {
        $value = $this->config->get("formfeed.{$name}");
        if ($value === null) {
            return null;
        }
        if (!is_string($value)) {
            throw new \InvalidArgumentException("config formfeed.{$name} must be a string");
        }
        $value = trim($value);

        return $value === '' ? null : $value;
    }

    private function int(string $name, int $default): int
    {
        $value = $this->config->get("formfeed.{$name}");
        if ($value === null || $value === '') {
            return $default;
        }
        if ((is_int($value) && $value >= 0) || (is_string($value) && preg_match('/^\s*\d+\s*$/', $value) === 1)) {
            return (int) $value;
        }
        throw new \InvalidArgumentException("config formfeed.{$name} must be a whole number of 0 or more");
    }

    private function float(string $name, float $default): float
    {
        $value = $this->config->get("formfeed.{$name}");
        if ($value === null || $value === '') {
            return $default;
        }
        if ((is_int($value) || is_float($value) || is_numeric($value)) && (float) $value > 0) {
            return (float) $value;
        }
        throw new \InvalidArgumentException("config formfeed.{$name} must be a number of seconds above 0");
    }
}
