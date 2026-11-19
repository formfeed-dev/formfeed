<?php

declare(strict_types=1);

namespace Formfeed\Internal;

use Formfeed\Upload;

/**
 * A multipart body the way the API reads it: the file as `file`, strings as they are, booleans and
 * numbers as text, arrays as JSON text. Null fields are left out, as a form field cannot say null,
 * but for redact's `fill`, whose null draws no box and goes as the JSON text `null`.
 *
 * @internal
 */
final class Multipart
{
    private readonly string $boundary;

    /** @var array<string, string> */
    private readonly array $fields;

    /**
     * @param array<string, mixed> $fields
     */
    public function __construct(array $fields, private readonly ?Upload $file)
    {
        $this->boundary = 'formfeed-' . bin2hex(random_bytes(12));
        $text = [];
        foreach ($fields as $name => $value) {
            if ($value === null && $name !== 'fill') {
                continue;
            }
            $text[$name] = match (true) {
                is_string($value) => $value,
                is_bool($value) => $value ? 'true' : 'false',
                is_int($value), is_float($value) => (string) $value,
                default => Json::encode($value),
            };
        }
        $this->fields = $text;
    }

    public function contentType(): string
    {
        return 'multipart/form-data; boundary=' . $this->boundary;
    }

    public function body(): string
    {
        $body = '';
        if ($this->file !== null) {
            $body .= "--{$this->boundary}\r\n"
                . 'Content-Disposition: form-data; name="file"; filename="' . self::quoted($this->file->name) . "\"\r\n"
                . "Content-Type: {$this->file->contentType}\r\n\r\n"
                . $this->file->contents . "\r\n";
        }
        foreach ($this->fields as $name => $value) {
            $body .= "--{$this->boundary}\r\n"
                . 'Content-Disposition: form-data; name="' . self::quoted($name) . "\"\r\n\r\n"
                . $value . "\r\n";
        }

        return $body . "--{$this->boundary}--\r\n";
    }

    /**
     * The fields as they are sent, for tests.
     *
     * @return array<string, string>
     */
    public function fields(): array
    {
        return $this->fields;
    }

    private static function quoted(string $value): string
    {
        return str_replace(['"', "\r", "\n"], ['%22', '', ''], $value);
    }
}
