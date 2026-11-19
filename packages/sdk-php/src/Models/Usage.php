<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/** The units of a billing period, with a daily series and a breakdown per template. */
final class Usage
{
    /**
     * @param list<array<string, mixed>> $daily      date, units and renders of each day
     * @param list<array<string, mixed>> $byTemplate template and units
     * @param array<string, mixed>       $raw
     */
    public function __construct(
        public readonly string $period,
        public readonly string $periodStart,
        public readonly string $periodEnd,
        public readonly float $included,
        public readonly float $used,
        public readonly float $overageUsed,
        public readonly float $overageBalance,
        public readonly ?float $hardCapUnits,
        public readonly array $daily,
        public readonly array $byTemplate,
        public readonly array $raw,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $cap = $data['hard_cap_units'] ?? null;

        return new self(
            period: Fields::string($data, 'period'),
            periodStart: Fields::string($data, 'period_start'),
            periodEnd: Fields::string($data, 'period_end'),
            included: Fields::float($data, 'included'),
            used: Fields::float($data, 'used'),
            overageUsed: Fields::float($data, 'overage_used'),
            overageBalance: Fields::float($data, 'overage_balance'),
            hardCapUnits: is_int($cap) || is_float($cap) ? (float) $cap : null,
            daily: Fields::objects($data, 'daily'),
            byTemplate: Fields::objects($data, 'by_template'),
            raw: $data,
        );
    }
}
