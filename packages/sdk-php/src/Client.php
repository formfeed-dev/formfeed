<?php

declare(strict_types=1);

namespace Formfeed;

use Formfeed\Internal\HttpClients;
use Formfeed\Internal\Transport;
use Formfeed\Resources\Account;
use Formfeed\Resources\Einvoices;
use Formfeed\Resources\Files;
use Formfeed\Resources\Jobs;
use Formfeed\Resources\Pdf;
use Formfeed\Resources\Renders;
use Formfeed\Resources\Templates;
use Formfeed\Resources\Webhooks;
use Http\Discovery\Psr17FactoryDiscovery;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * The Formfeed API.
 *
 *     $formfeed = new Formfeed\Client(apiKey: getenv('FORMFEED_API_KEY'));
 *     $render = $formfeed->renders->create(['template' => 'invoice', 'data' => $data]);
 *     file_put_contents('invoice.pdf', $formfeed->renders->download($render));
 *
 * It sends over any PSR-18 client: the one you pass, else Guzzle or Symfony's HttpClient with a
 * limit of `$timeout` seconds where one is installed, else whatever php-http/discovery finds.
 */
final class Client
{
    public const VERSION = '0.3.28';

    private const HOSTS = [
        'eu' => 'https://api-eu.formfeed.dev/v1',
        'us' => 'https://api-us.formfeed.dev/v1',
    ];

    public readonly Renders $renders;
    public readonly Jobs $jobs;
    public readonly Pdf $pdf;
    public readonly Einvoices $einvoices;
    public readonly Files $files;
    public readonly Templates $templates;
    public readonly Webhooks $webhooks;
    public readonly Account $account;

    private readonly Transport $transport;

    /**
     * @param string                       $region     `eu` or `us`; ignored when `$baseUrl` is given
     * @param string|null                  $baseUrl    the full base URL with `/v1`, for a local or another gateway
     * @param int                          $maxRetries retries on 429, 503 and network errors; 0 turns them off
     * @param float                        $timeout    seconds, for the client the SDK picks itself
     * @param array<string, string>        $headers    sent with every request, after the SDK's own
     * @param (\Closure(float): void)|null $sleep      how to wait between retries and polls, in seconds
     */
    public function __construct(
        string $apiKey,
        string $region = 'eu',
        ?string $baseUrl = null,
        ?ClientInterface $httpClient = null,
        ?RequestFactoryInterface $requestFactory = null,
        ?StreamFactoryInterface $streamFactory = null,
        int $maxRetries = 3,
        float $timeout = 120.0,
        array $headers = [],
        ?\Closure $sleep = null,
    ) {
        if ($apiKey === '') {
            throw new FormfeedException('invalid_request', 'apiKey is required');
        }
        $host = $baseUrl ?? self::HOSTS[$region]
            ?? throw new FormfeedException('invalid_request', "unknown region {$region}: eu or us, or a baseUrl");

        $this->transport = new Transport(
            $apiKey,
            rtrim($host, '/'),
            $httpClient ?? HttpClients::create($timeout),
            $requestFactory ?? Psr17FactoryDiscovery::findRequestFactory(),
            $streamFactory ?? Psr17FactoryDiscovery::findStreamFactory(),
            max(0, $maxRetries),
            $headers,
            $sleep,
        );
        $this->renders = new Renders($this->transport);
        $this->jobs = new Jobs($this->transport);
        $this->pdf = new Pdf($this->transport);
        $this->einvoices = new Einvoices($this->transport);
        $this->files = new Files($this->transport);
        $this->templates = new Templates($this->transport);
        $this->webhooks = new Webhooks($this->transport);
        $this->account = new Account($this->transport);
    }

    /**
     * Any call of the API with the client's key, retries and problems, for one without a method here
     * (template authoring, channels, shared partials): the decoded JSON answer, null for none.
     *
     * @param array<string, mixed>|null $body
     */
    public function request(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): mixed
    {
        return $this->transport->json($method, $path, $body, $idempotencyKey);
    }
}
