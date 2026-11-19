<?php

declare(strict_types=1);

namespace Formfeed\Internal;

/**
 * @internal
 */
final class Query
{
    /**
     * `?a=1&b=2` of the values that are set, or an empty string; booleans as `true` and `false`.
     *
     * @param array<string, mixed> $query
     */
    public static function string(array $query): string
    {
        $pairs = [];
        foreach ($query as $key => $value) {
            if ($value === null || $value === '') {
                continue;
            }
            if (is_bool($value)) {
                $value = $value ? 'true' : 'false';
            }
            if (!is_scalar($value)) {
                continue;
            }
            $pairs[] = rawurlencode($key) . '=' . rawurlencode((string) $value);
        }

        return $pairs === [] ? '' : '?' . implode('&', $pairs);
    }
}
