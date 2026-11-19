<?php

declare(strict_types=1);

namespace Formfeed\Tests;

use Formfeed\Models\Job;
use Formfeed\Models\Page;
use Formfeed\Models\Render;
use Formfeed\Models\RenderInput;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The contract goldens (plan 25 §5.3): what the API answers today, written by the gateway's
 * `contract.spec.ts`. Each is read with the model its name starts with, so a change of an answer
 * that the SDK cannot read fails here before it ships. They live in the Formfeed repository only;
 * the public repository carries the shared vectors without them, and skips these tests.
 */
final class GoldensTest extends TestCase
{
    private static function folder(): string
    {
        return dirname(__DIR__, 2) . '/api-types/fixtures/contract';
    }

    /** @return array<string, array{string}> */
    public static function goldens(): array
    {
        $files = glob(self::folder() . '/*.json') ?: [];
        $out = [];
        foreach ($files as $file) {
            $out[basename($file)] = [$file];
        }

        // a data provider may not be empty: outside the repository, one case that skips
        return $out === [] ? ['no goldens here' => ['']] : $out;
    }

    public function testThereAreGoldens(): void
    {
        if (!is_dir(self::folder())) {
            self::markTestSkipped('outside the Formfeed repository, which holds the contract goldens');
        }
        self::assertNotEmpty(glob(self::folder() . '/*.json') ?: []);
    }

    #[DataProvider('goldens')]
    public function testTheSdkReadsTheGolden(string $file): void
    {
        if ($file === '') {
            self::markTestSkipped('outside the Formfeed repository, which holds the contract goldens');
        }
        $data = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($data);
        /** @var array<string, mixed> $data */
        $name = basename($file, '.json');

        if ($name === 'render-page' || str_starts_with($name, 'render-page-')) {
            $page = Page::fromArray($data, Render::fromArray(...));
            self::assertNotEmpty($page->data);
            foreach ($page->data as $render) {
                self::assertStringStartsWith('rnd_', $render->id);
            }
        } elseif ($name === 'render-input' || str_starts_with($name, 'render-input-')) {
            self::assertStringStartsWith('rnd_', RenderInput::fromArray($data)->renderId);
        } elseif (str_starts_with($name, 'render')) {
            $render = Render::fromArray($data);
            self::assertStringStartsWith('rnd_', $render->id);
            self::assertNotSame('', $render->status);
        } elseif (str_starts_with($name, 'job')) {
            $job = Job::fromArray($data);
            self::assertStringStartsWith('job_', $job->id);
            self::assertCount($job->total, $job->items);
        } else {
            self::fail("{$name}.json: no model is named for this file");
        }
    }
}
