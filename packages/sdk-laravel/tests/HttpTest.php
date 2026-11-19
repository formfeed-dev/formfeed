<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use Formfeed\Client;
use Formfeed\FormfeedException;

/**
 * The client the container makes, over the HTTP client a Laravel application has (Guzzle 7 with
 * Laravel 12, Guzzle 8 with Laravel 13), against a stand-in API on a real socket: the settings reach
 * the request, a problem stays an answer, and the time limit holds.
 */
final class HttpTest extends TestCase
{
    /** @var resource|null */
    private static $server = null;

    private static string $address = '';
    private static string $log = '';

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        $socket = stream_socket_server('tcp://127.0.0.1:0', $code, $error);
        if ($socket === false) {
            throw new \RuntimeException("no free port: {$error}");
        }
        self::$address = (string) stream_socket_get_name($socket, false);
        fclose($socket);
        self::$log = (string) tempnam(sys_get_temp_dir(), 'formfeed-http-');

        $server = proc_open(
            [PHP_BINARY, '-S', self::$address, __DIR__ . '/Support/gateway.php'],
            [['pipe', 'r'], ['file', '/dev/null', 'w'], ['file', '/dev/null', 'w']],
            $pipes,
            null,
            ['FORMFEED_HTTP_LOG' => self::$log, 'PHP_CLI_SERVER_WORKERS' => '4'],
        );
        if ($server === false) {
            throw new \RuntimeException('php -S did not start');
        }
        self::$server = $server;
        for ($attempt = 0; $attempt < 100; ++$attempt) {
            $connection = @fsockopen('tcp://' . self::$address);
            if ($connection !== false) {
                fclose($connection);

                return;
            }
            usleep(50_000);
        }
        throw new \RuntimeException('php -S did not answer within five seconds');
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$server !== null) {
            proc_terminate(self::$server);
            proc_close(self::$server);
            self::$server = null;
        }
        @unlink(self::$log);
        parent::tearDownAfterClass();
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->config()->set('formfeed.base_url', 'http://' . self::$address . '/v1');
        $this->config()->set('formfeed.max_retries', 0);
    }

    public function testTheKeyAndTheAddressFromTheSettingsReachTheApi(): void
    {
        $render = $this->resolve(Client::class)->renders->create(['template' => 'invoice', 'data' => ['number' => 'RE-1']]);

        self::assertSame('rnd_1', $render->id);
        $seen = $this->seen();
        self::assertSame('POST', $seen['method']);
        self::assertSame('/v1/renders', $seen['path']);
        self::assertSame('Bearer ' . self::KEY, $seen['authorization']);
        self::assertSame('formfeed-sdk-php/0.3', $seen['user_agent']);
        self::assertIsString($seen['idempotency_key']);
        self::assertSame(['template' => 'invoice', 'data' => ['number' => 'RE-1']], json_decode((string) $seen['body'], true));
    }

    public function testAProblemComesBackAsTheSdksException(): void
    {
        try {
            $this->resolve(Client::class)->request('GET', '/missing');
            self::fail('a problem');
        } catch (FormfeedException $e) {
            self::assertSame(['not_found', 404, 'No such thing', 'req_404'], [$e->errorCode, $e->status, $e->getMessage(), $e->requestId]);
        }
    }

    public function testTheTimeLimitFromTheSettingsHolds(): void
    {
        $this->config()->set('formfeed.timeout', 0.3);
        $started = microtime(true);

        try {
            $this->resolve(Client::class)->request('GET', '/slow');
            self::fail('an answer after the time limit');
        } catch (FormfeedException $e) {
            self::assertSame('network_error', $e->errorCode);
        }
        // cut at 0.3 s; the answer would take 2 s, and a busy machine needs some of the rest
        self::assertLessThan(1.5, microtime(true) - $started);
    }

    /** @return array<string, mixed> */
    private function seen(): array
    {
        $seen = json_decode((string) file_get_contents(self::$log), true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($seen);

        /** @var array<string, mixed> $seen */
        return $seen;
    }
}
