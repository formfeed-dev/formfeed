<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Testing;

use Formfeed\Upload;
use Illuminate\Support\Arr;
use Illuminate\Support\Str;
use Psr\Http\Message\RequestInterface;

/**
 * A request the fake answered, read back: the method, the path without `/v1`, the query, and the body
 * as the API reads it. A JSON body is decoded; a multipart one (the PDF tools on an upload, `convert`,
 * the file library, e-invoice validation) is its fields as the text that was sent, an array or object
 * field decoded from its JSON, and the file as an `Upload`.
 */
final class FormfeedRequest
{
    /**
     * @param array<string, mixed> $query
     * @param array<string, mixed> $body
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query,
        public readonly array $body,
        public readonly ?Upload $file,
        public readonly RequestInterface $psr,
    ) {}

    /** @internal */
    public static function from(RequestInterface $request, string $basePath): self
    {
        $path = $request->getUri()->getPath();
        if ($basePath !== '' && str_starts_with($path, $basePath)) {
            $path = substr($path, strlen($basePath));
        }
        parse_str($request->getUri()->getQuery(), $query);
        [$body, $file] = self::body($request);

        return new self(
            strtoupper($request->getMethod()),
            $path === '' ? '/' : rawurldecode($path),
            self::stringKeys($query),
            $body,
            $file,
            $request,
        );
    }

    /**
     * Whether the request is the one a pattern names: `POST /renders`, `GET /renders/*`, `/pdf/*`
     * for any method. `*` matches anything; a leading `/v1` is left out.
     */
    public function is(string $pattern): bool
    {
        $pattern = trim($pattern);
        $method = null;
        if (preg_match('/^([A-Za-z]+)\s+(\S.*)$/', $pattern, $parts) === 1) {
            [, $method, $pattern] = $parts;
        }
        if (str_starts_with($pattern, '/v1/') || $pattern === '/v1') {
            $pattern = substr($pattern, 3);
        }
        if ($pattern === '') {
            $pattern = '/';
        }

        return ($method === null || strtoupper($method) === $this->method) && Str::is($pattern, $this->path);
    }

    /** A value of the body by its dotted path (`data.customer.name`), or the default. */
    public function input(string $key, mixed $default = null): mixed
    {
        return Arr::get($this->body, $key, $default);
    }

    public function header(string $name): string
    {
        return $this->psr->getHeaderLine($name);
    }

    public function idempotencyKey(): ?string
    {
        $key = $this->header('Idempotency-Key');

        return $key === '' ? null : $key;
    }

    /** `POST /renders`, for messages. */
    public function __toString(): string
    {
        return "{$this->method} {$this->path}";
    }

    /**
     * @return array{array<string, mixed>, Upload|null}
     */
    private static function body(RequestInterface $request): array
    {
        $text = (string) $request->getBody();
        if ($text === '') {
            return [[], null];
        }
        if (preg_match('/^multipart\/form-data;\s*boundary="?([^";\s]+)"?/i', $request->getHeaderLine('Content-Type'), $match) === 1) {
            return self::multipart($text, $match[1]);
        }
        try {
            $decoded = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [[], null];
        }

        return [is_array($decoded) ? self::stringKeys($decoded) : [], null];
    }

    /**
     * @return array{array<string, mixed>, Upload|null}
     */
    private static function multipart(string $text, string $boundary): array
    {
        $fields = [];
        $file = null;
        foreach (explode("--{$boundary}", $text) as $chunk) {
            if (!str_contains($chunk, "\r\n\r\n")) {
                continue;
            }
            [$head, $content] = explode("\r\n\r\n", ltrim($chunk, "\r\n"), 2);
            if (str_ends_with($content, "\r\n")) {
                $content = substr($content, 0, -2);
            }
            if (preg_match('/name="([^"]*)"/', $head, $name) !== 1) {
                continue;
            }
            if (preg_match('/filename="([^"]*)"/', $head, $filename) === 1) {
                $type = preg_match('/Content-Type:\s*(.+)/i', $head, $contentType) === 1 ? trim($contentType[1]) : null;
                $file = Upload::fromString($content, $filename[1], $type);
                continue;
            }
            $fields[$name[1]] = self::field($content);
        }

        return [$fields, $file];
    }

    /** An array or object field as its JSON says, every other one as the text that was sent. */
    private static function field(string $content): mixed
    {
        $trimmed = ltrim($content);
        if ($trimmed !== '' && ($trimmed[0] === '{' || $trimmed[0] === '[')) {
            try {
                $decoded = json_decode($content, true, 512, JSON_THROW_ON_ERROR);
                if (is_array($decoded)) {
                    return $decoded;
                }
            } catch (\JsonException) {
                // a text that starts like JSON and is not: it stays the text
            }
        }

        return $content;
    }

    /**
     * @param array<mixed> $value
     *
     * @return array<string, mixed>
     */
    private static function stringKeys(array $value): array
    {
        $result = [];
        foreach ($value as $key => $item) {
            $result[(string) $key] = $item;
        }

        return $result;
    }
}
