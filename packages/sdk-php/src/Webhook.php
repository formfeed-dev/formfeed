<?php

declare(strict_types=1);

namespace Formfeed;

/**
 * Checks a webhook delivery: `Webhook-Signature: t=<unix>,v1=<hex>`, the HMAC-SHA256 of
 * `<t>.<raw body>` with the endpoint's secret, at most 300 seconds either way, compared in constant
 * time. Pass the body exactly as it arrived: the signature covers the bytes on the wire.
 *
 *     $event = Formfeed\Webhook::parse($secret, $_SERVER['HTTP_WEBHOOK_SIGNATURE'] ?? null, file_get_contents('php://input'));
 */
final class Webhook
{
    public static function verify(
        string $secret,
        ?string $signatureHeader,
        string $rawBody,
        int $toleranceSeconds = 300,
        ?int $now = null,
    ): bool {
        if ($signatureHeader === null || $signatureHeader === '' || $secret === '') {
            return false;
        }
        $parts = [];
        foreach (explode(',', $signatureHeader) as $pair) {
            [$key, $value] = array_pad(explode('=', trim($pair), 2), 2, '');
            $parts[trim($key)] = trim($value);
        }
        $t = $parts['t'] ?? '';
        $v1 = strtolower($parts['v1'] ?? '');
        if (!ctype_digit($t) || preg_match('/^[0-9a-f]{64}$/', $v1) !== 1) {
            return false;
        }
        $time = (int) $t;
        if (abs(($now ?? time()) - $time) > $toleranceSeconds) {
            return false;
        }

        return hash_equals(hash_hmac('sha256', $time . '.' . $rawBody, $secret), $v1);
    }

    /**
     * The event of a verified delivery: `id`, `type`, `created_at`, `workspace_id` and `data`.
     *
     * @return array<string, mixed>
     *
     * @throws \UnexpectedValueException when the signature does not match
     */
    public static function parse(
        string $secret,
        ?string $signatureHeader,
        string $rawBody,
        int $toleranceSeconds = 300,
        ?int $now = null,
    ): array {
        if (!self::verify($secret, $signatureHeader, $rawBody, $toleranceSeconds, $now)) {
            throw new \UnexpectedValueException('invalid webhook signature');
        }
        $event = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($event)) {
            throw new \UnexpectedValueException('the webhook body is not a JSON object');
        }

        return Internal\Fields::stringKeys($event);
    }
}
