<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Tests;

use PHPUnit\Framework\TestCase;

/**
 * One version for every package (plan 34, decision 6): the Laravel package of a release needs the
 * SDK of that release, so a release bumps the requirement with the other version places.
 */
final class VersionTest extends TestCase
{
    public function testTheSdkItNeedsIsTheReleasesOne(): void
    {
        $publish = dirname(__DIR__, 3) . '/tools/publish/packages.mjs';
        if (!is_file($publish)) {
            self::markTestSkipped('outside the Formfeed repository, which holds the release version');
        }
        if (preg_match("/export const VERSION = '([^']+)';/", (string) file_get_contents($publish), $match) !== 1) {
            self::fail('no VERSION in tools/publish/packages.mjs');
        }
        $version = $match[1];

        $composer = json_decode((string) file_get_contents(dirname(__DIR__) . '/composer.json'), true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($composer);
        self::assertSame("^{$version}", $composer['require']['formfeed/sdk'] ?? null);
        // the SDK's working copy, which the tests here run against, stands in for that release
        self::assertSame($version, $composer['repositories'][0]['options']['versions']['formfeed/sdk'] ?? null);
        self::assertSame('../sdk-php', $composer['repositories'][0]['url'] ?? null);
    }
}
