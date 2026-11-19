<?php

declare(strict_types=1);

namespace Formfeed\Internal;

/**
 * @internal
 */
final class Json
{
    /** JSON as the API reads it: an empty array at the top is the empty object, and slashes stay as they are. */
    public static function encode(mixed $value): string
    {
        return json_encode(
            $value === [] ? new \stdClass() : $value,
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION,
        );
    }

    /**
     * The request with the named members that are empty arrays as empty objects: PHP has one empty
     * array where JSON has `[]` and `{}`, and `data` and `settings` are objects.
     *
     * @param array<string, mixed> $request
     * @param list<string>         $members
     *
     * @return array<string, mixed>
     */
    public static function objects(array $request, array $members): array
    {
        foreach ($members as $member) {
            if (array_key_exists($member, $request) && $request[$member] === []) {
                $request[$member] = new \stdClass();
            }
        }

        return $request;
    }
}
