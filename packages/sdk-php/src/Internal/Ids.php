<?php

declare(strict_types=1);

namespace Formfeed\Internal;

use Formfeed\Models\Job;
use Formfeed\Models\LibraryFile;
use Formfeed\Models\Render;

/**
 * @internal
 */
final class Ids
{
    /** The id of a render, job or library file, or the string given (an id or a library file's name). */
    public static function of(Render|Job|LibraryFile|string $item): string
    {
        return is_string($item) ? $item : $item->id;
    }

    /** A fresh Idempotency-Key: every call that creates a render sends one, so a retry cannot charge twice. */
    public static function key(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0F) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3F) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    /** One path segment, encoded. */
    public static function path(Render|Job|LibraryFile|string $item): string
    {
        return rawurlencode(self::of($item));
    }
}
