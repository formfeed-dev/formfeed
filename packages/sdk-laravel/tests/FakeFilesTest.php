<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use Formfeed\Laravel\Testing\Internal\FakeFiles;
use PHPUnit\Framework\TestCase;

/** The fake's files are files: what readers check before they open one holds. */
final class FakeFilesTest extends TestCase
{
    public function testAPdfHasItsPagesAndAnXrefThatPointsAtItsObjects(): void
    {
        $pdf = FakeFiles::pdf(3);

        self::assertStringStartsWith("%PDF-1.7\n", $pdf);
        self::assertStringEndsWith("%%EOF\n", $pdf);
        self::assertStringContainsString('/Count 3', $pdf);
        self::assertSame(3, substr_count($pdf, '/Type /Page '));

        if (preg_match('/startxref\n(\d+)\n%%EOF\n$/', $pdf, $start) !== 1) {
            self::fail('no startxref at the end');
        }
        $xref = (int) $start[1];
        self::assertSame("xref\n", substr($pdf, $xref, 5));
        if (preg_match('/^xref\n0 (\d+)\n/', substr($pdf, $xref), $size) !== 1) {
            self::fail('no xref section where startxref points');
        }
        $entries = (int) $size[1];
        self::assertSame(1 + 3 + 2 * 3, $entries);
        $table = substr($pdf, $xref + strlen("xref\n0 {$entries}\n"), 20 * $entries);
        foreach (str_split($table, 20) as $number => $entry) {
            if ($number === 0) {
                self::assertSame("0000000000 65535 f \n", $entry);
                continue;
            }
            self::assertSame("{$number} 0 obj", substr($pdf, (int) substr($entry, 0, 10), strlen("{$number} 0 obj")), "object {$number}");
        }
    }

    public function testAPdfHasAtLeastOnePage(): void
    {
        self::assertStringContainsString('/Count 1', FakeFiles::pdf(0));
    }

    public function testThePicturesAreOnePixelOfTheirFormat(): void
    {
        foreach (['png' => IMAGETYPE_PNG, 'jpg' => IMAGETYPE_JPEG, 'webp' => IMAGETYPE_WEBP] as $output => $type) {
            $size = getimagesizefromstring(FakeFiles::for($output, 1));
            self::assertIsArray($size, $output);
            self::assertSame([1, 1, $type], [$size[0], $size[1], $size[2]], $output);
            self::assertSame(image_type_to_mime_type($type), FakeFiles::contentType($output));
        }
    }

    public function testThePngIsWhole(): void
    {
        $png = FakeFiles::png();
        $offset = 8;
        $types = [];
        while ($offset < strlen($png)) {
            $length = unpack('N', substr($png, $offset, 4));
            self::assertIsArray($length);
            $type = substr($png, $offset + 4, 4);
            $data = substr($png, $offset + 8, $length[1]);
            $crc = unpack('N', substr($png, $offset + 8 + $length[1], 4));
            self::assertIsArray($crc);
            self::assertSame(crc32($type . $data), $crc[1], "the CRC of {$type}");
            if ($type === 'IDAT' && function_exists('gzuncompress')) {
                self::assertSame("\x00\x00\x00\x00\x00", gzuncompress($data));
            }
            $types[] = $type;
            $offset += 12 + $length[1];
        }
        self::assertSame(['IHDR', 'IDAT', 'IEND'], $types);
    }

    public function testOfficeFilesAndPartsAreZipArchives(): void
    {
        foreach (['zip', 'docx', 'pptx'] as $output) {
            self::assertSame("PK\x05\x06" . str_repeat("\x00", 18), FakeFiles::for($output, 1), $output);
        }
        self::assertSame('application/vnd.openxmlformats-officedocument.wordprocessingml.document', FakeFiles::contentType('docx'));
        self::assertSame('application/zip', FakeFiles::contentType('zip'));
    }
}
