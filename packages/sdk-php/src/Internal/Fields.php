<?php

declare(strict_types=1);

namespace Formfeed\Internal;

/**
 * Typed reads of a decoded answer. A field the API leaves out reads as its default, so an SDK of
 * today reads the answers of a later API (the contract goldens hold that).
 *
 * @internal
 */
final class Fields
{
    /** @param array<string, mixed> $from */
    public static function string(array $from, string $key, string $default = ''): string
    {
        $value = $from[$key] ?? null;

        return is_string($value) ? $value : (is_int($value) || is_float($value) ? (string) $value : $default);
    }

    /** @param array<string, mixed> $from */
    public static function stringOrNull(array $from, string $key): ?string
    {
        $value = $from[$key] ?? null;

        return is_string($value) ? $value : null;
    }

    /** @param array<string, mixed> $from */
    public static function int(array $from, string $key, int $default = 0): int
    {
        $value = $from[$key] ?? null;

        return is_int($value) ? $value : (is_float($value) ? (int) $value : $default);
    }

    /** @param array<string, mixed> $from */
    public static function intOrNull(array $from, string $key): ?int
    {
        $value = $from[$key] ?? null;

        return is_int($value) ? $value : (is_float($value) ? (int) $value : null);
    }

    /** @param array<string, mixed> $from */
    public static function float(array $from, string $key, float $default = 0.0): float
    {
        $value = $from[$key] ?? null;

        return is_int($value) || is_float($value) ? (float) $value : $default;
    }

    /** @param array<string, mixed> $from */
    public static function bool(array $from, string $key, bool $default = false): bool
    {
        $value = $from[$key] ?? null;

        return is_bool($value) ? $value : $default;
    }

    /**
     * @param array<string, mixed> $from
     *
     * @return array<string, mixed>
     */
    public static function map(array $from, string $key): array
    {
        return self::mapOrNull($from, $key) ?? [];
    }

    /**
     * @param array<string, mixed> $from
     *
     * @return array<string, mixed>|null
     */
    public static function mapOrNull(array $from, string $key): ?array
    {
        $value = $from[$key] ?? null;

        return is_array($value) ? self::stringKeys($value) : null;
    }

    /**
     * @param array<string, mixed> $from
     *
     * @return list<string>
     */
    public static function strings(array $from, string $key): array
    {
        $value = $from[$key] ?? null;
        if (!is_array($value)) {
            return [];
        }

        return array_values(array_filter($value, is_string(...)));
    }

    /**
     * The entries of a list that are objects, each with string keys.
     *
     * @param array<string, mixed> $from
     *
     * @return list<array<string, mixed>>
     */
    public static function objects(array $from, string $key): array
    {
        $value = $from[$key] ?? null;
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $item) {
            if (is_array($item)) {
                $out[] = self::stringKeys($item);
            }
        }

        return $out;
    }

    /**
     * @param array<mixed> $value
     *
     * @return array<string, mixed>
     */
    public static function stringKeys(array $value): array
    {
        $out = [];
        foreach ($value as $key => $item) {
            $out[(string) $key] = $item;
        }

        return $out;
    }
}
