<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Testing;

/**
 * Answers in turn, one per request the pattern matches, made by `FormfeedFake::sequence()`; once
 * they are used up, the fake answers as it would without them.
 */
final class FakeSequence
{
    /** @var list<mixed> */
    private array $answers;

    public function __construct(mixed ...$answers)
    {
        $this->answers = array_values($answers);
    }

    /** @internal the next answer, null when there is none left */
    public function next(): mixed
    {
        return array_shift($this->answers);
    }
}
