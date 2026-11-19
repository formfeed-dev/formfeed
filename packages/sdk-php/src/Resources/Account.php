<?php

declare(strict_types=1);

namespace Formfeed\Resources;

use Formfeed\Internal\Transport;
use Formfeed\Models\Usage;

final class Account
{
    /** @internal */
    public function __construct(private readonly Transport $transport) {}

    /**
     * The key's organisation, workspace, plan and scopes.
     *
     * @return array<string, mixed>
     */
    public function get(): array
    {
        return $this->transport->object('GET', '/account');
    }

    /** Units of the current period, or of `YYYY-MM`, with a daily series and a breakdown per template. */
    public function usage(string $period = 'current'): Usage
    {
        return Usage::fromArray($this->transport->object('GET', '/usage?period=' . rawurlencode($period)));
    }
}
