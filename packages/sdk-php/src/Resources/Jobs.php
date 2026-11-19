<?php

declare(strict_types=1);

namespace Formfeed\Resources;

use Formfeed\FormfeedException;
use Formfeed\Internal\Ids;
use Formfeed\Internal\Transport;
use Formfeed\Models\Job;

final class Jobs
{
    /** @internal */
    public function __construct(private readonly Transport $transport) {}

    public function get(Job|string $job): Job
    {
        return Job::fromArray($this->transport->object('GET', '/jobs/' . Ids::path($job)));
    }

    /** Polls until no render of the job is queued or running, at most `$timeout` seconds. */
    public function waitFor(Job|string $job, float $timeout = 600.0, float $interval = 2.0): Job
    {
        $id = Ids::of($job);
        $started = microtime(true);
        $waited = 0.0;
        while (true) {
            $current = $this->get($id);
            if ($current->finished()) {
                return $current;
            }
            if (max(microtime(true) - $started, $waited) + $interval > $timeout) {
                throw new FormfeedException('timeout', "job {$id} did not finish within the wait time");
            }
            $this->transport->wait($interval);
            $waited += $interval;
        }
    }
}
