<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Testing\Internal;

/**
 * The files behind the fake's download links: small, but files every reader opens, so a test may
 * store, attach or read them. A PDF has as many pages as its render says.
 *
 * @internal
 */
final class FakeFiles
{
    /** A 1×1 lossless WebP, the one browsers' feature tests decode. */
    private const WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

    public static function for(string $output, int $pages): string
    {
        return match ($output) {
            'pdf' => self::pdf($pages),
            'png' => self::png(),
            'jpg', 'jpeg' => self::jpeg(),
            'webp' => (string) base64_decode(self::WEBP, true),
            // a Word or PowerPoint file and a ZIP of parts are ZIP archives; the fake's holds nothing
            default => self::zip(),
        };
    }

    public static function contentType(string $output): string
    {
        return match ($output) {
            'pdf' => 'application/pdf',
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            default => 'application/zip',
        };
    }

    /** A PDF of A4 pages, each saying that it is a fake. */
    public static function pdf(int $pages): string
    {
        $pages = max(1, $pages);
        // objects: 1 catalog, 2 page tree, 3 font, then a page and its content stream for each page
        $objects = [
            1 => '<< /Type /Catalog /Pages 2 0 R >>',
            2 => '',
            3 => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        ];
        $kids = [];
        for ($page = 1; $page <= $pages; ++$page) {
            $pageObject = 2 + 2 * $page;
            $contents = $pageObject + 1;
            $kids[] = "{$pageObject} 0 R";
            $objects[$pageObject] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R >> >> /Contents {$contents} 0 R >>";
            $stream = "BT /F1 11 Tf 56.69 785.2 Td (Formfeed::fake\\(\\), page {$page} of {$pages}) Tj ET";
            $objects[$contents] = '<< /Length ' . strlen($stream) . " >>\nstream\n{$stream}\nendstream";
        }
        $objects[2] = '<< /Type /Pages /Kids [' . implode(' ', $kids) . "] /Count {$pages} >>";
        ksort($objects);

        $pdf = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
        $offsets = [];
        foreach ($objects as $number => $object) {
            $offsets[$number] = strlen($pdf);
            $pdf .= "{$number} 0 obj\n{$object}\nendobj\n";
        }
        $xref = strlen($pdf);
        $size = count($objects) + 1;
        // every entry of the table is 20 bytes, its line ending included
        $pdf .= "xref\n0 {$size}\n0000000000 65535 f \n";
        foreach ($offsets as $offset) {
            $pdf .= sprintf("%010d 00000 n \n", $offset);
        }

        return $pdf . "trailer\n<< /Size {$size} /Root 1 0 R >>\nstartxref\n{$xref}\n%%EOF\n";
    }

    /** A 1×1 transparent PNG, compressed without the zlib extension (a stored deflate block). */
    public static function png(): string
    {
        $chunk = static fn(string $type, string $data): string => pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
        // one row: filter type 0, then red, green, blue and alpha
        $row = "\x00\x00\x00\x00\x00";
        $zlib = "\x78\x01\x01" . pack('v', strlen($row)) . pack('v', ~strlen($row) & 0xFFFF) . $row . hash('adler32', $row, true);

        return "\x89PNG\r\n\x1a\n"
            . $chunk('IHDR', pack('NNCCCCC', 1, 1, 8, 6, 0, 0, 0))
            . $chunk('IDAT', $zlib)
            . $chunk('IEND', '');
    }

    /**
     * A baseline JPEG of one grey pixel: an 8×8 block whose coefficients are all 0, coded with
     * Huffman tables of one code each.
     */
    public static function jpeg(): string
    {
        $segment = static fn(string $marker, string $data): string => "\xFF{$marker}" . pack('n', strlen($data) + 2) . $data;
        $oneCode = str_repeat("\x00", 15);

        return "\xFF\xD8"
            . $segment("\xE0", "JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
            . $segment("\xDB", "\x00" . str_repeat("\x01", 64))
            . $segment("\xC0", "\x08\x00\x01\x00\x01\x01\x01\x11\x00")
            . $segment("\xC4", "\x00\x01{$oneCode}\x00")
            . $segment("\xC4", "\x10\x01{$oneCode}\x00")
            . $segment("\xDA", "\x01\x01\x00\x00\x3F\x00")
            // DC: the code 0 for a difference of 0; AC: the code 0 for end of block; padded with ones
            . "\x3F"
            . "\xFF\xD9";
    }

    /** An empty ZIP archive: its end-of-central-directory record alone. */
    public static function zip(): string
    {
        return "PK\x05\x06" . str_repeat("\x00", 18);
    }
}
