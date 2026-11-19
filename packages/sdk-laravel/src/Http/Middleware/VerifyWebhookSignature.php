<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Http\Middleware;

use Formfeed\Laravel\Internal\Settings;
use Formfeed\Webhook;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * `formfeed.webhook`: lets a delivery through only when its `Webhook-Signature` matches the body as
 * it arrived, signed with `FORMFEED_WEBHOOK_SECRET` no more than `webhook_tolerance` seconds from
 * now (Laravel's clock, so a test can travel); anything else is answered 401, which Formfeed
 * retries. The event is then the request's JSON: `$request->input('type')`, `$request->input('data')`.
 */
final class VerifyWebhookSignature
{
    public function __construct(private readonly Repository $config) {}

    /**
     * @param \Closure(Request): Response $next
     */
    public function handle(Request $request, \Closure $next): Response
    {
        $settings = new Settings($this->config);
        $secret = $settings->webhookSecret();
        if ($secret === null) {
            // a server error, not a refusal: the deliveries are retried until the secret is set
            throw new \RuntimeException(
                'The Formfeed webhook secret is not set: add FORMFEED_WEBHOOK_SECRET to .env, which config/formfeed.php reads',
            );
        }

        $header = $request->headers->get('Webhook-Signature');
        if (!Webhook::verify($secret, $header, $request->getContent(), $settings->webhookTolerance(), Carbon::now()->getTimestamp())) {
            throw new HttpException(401, 'Invalid Formfeed webhook signature.');
        }

        return $next($request);
    }
}
