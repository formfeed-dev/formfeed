<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/**
 * One page of a list, newest first, and the cursor of the next (null on the last).
 *
 * @template T
 */
final class Page
{
    /**
     * @param list<T> $data
     */
    public function __construct(
        public readonly array $data,
        public readonly ?string $nextCursor,
    ) {}

    /**
     * @template U
     *
     * @param array<string, mixed>                $page
     * @param callable(array<string, mixed>): U   $item
     *
     * @return Page<U>
     */
    public static function fromArray(array $page, callable $item): self
    {
        return new self(
            array_map($item, Fields::objects($page, 'data')),
            Fields::stringOrNull($page, 'next_cursor'),
        );
    }
}
