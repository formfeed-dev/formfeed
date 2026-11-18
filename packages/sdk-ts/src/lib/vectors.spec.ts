import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Formfeed, FormfeedError } from './client';
import { verifyWebhookSignature } from './webhooks';

/**
 * The test vectors every SDK reads (plan 34, decision 9), written by
 * `packages/api-types/src/lib/sdk-fixtures.spec.ts`: webhook signatures, retries and problems,
 * played through the client as a caller meets them.
 */
const VECTORS = resolve(__dirname, '../../../api-types/fixtures/sdk');
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(VECTORS, `${name}.json`), 'utf8')) as T;

interface Answer {
  status?: number;
  retry_after?: string;
  body?: Record<string, unknown>;
  network_error?: true;
}

const webhooks = read<{
  secret: string;
  now: number;
  tolerance_seconds: number;
  body: string;
  cases: Array<{
    name: string;
    header: string | null;
    body: string | null;
    valid: boolean;
  }>;
}>('webhook-signatures');

const retries = read<{
  max_retries: number;
  cases: Array<{
    name: string;
    answers: Answer[];
    waits_ms: Array<[number, number]>;
    outcome: { ok: true } | { error: { code: string; status: number } };
  }>;
}>('retries');

const problems = read<{
  cases: Array<{
    name: string;
    status: number;
    headers: Record<string, string>;
    body: unknown;
    expect: {
      code: string;
      message: string;
      status: number;
      request_id: string | null;
    };
  }>;
}>('problems');

describe('webhook signatures', () => {
  it.each(webhooks.cases)('$name', async ({ header, body, valid }) => {
    await expect(
      verifyWebhookSignature(webhooks.secret, header, body ?? webhooks.body, {
        now: webhooks.now,
        toleranceSeconds: webhooks.tolerance_seconds,
      }),
    ).resolves.toBe(valid);
  });
});

// The request's own time limit, told apart from the waits between attempts by its value.
const TIMEOUT_MS = 987_654;

async function play(answers: Answer[], jitter: number) {
  vi.spyOn(Math, 'random').mockReturnValue(jitter);
  const waits: number[] = [];
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms?: number,
  ) => {
    if (ms !== TIMEOUT_MS) {
      waits.push(ms ?? 0);
      queueMicrotask(callback);
    }
    return 0;
  }) as unknown as typeof setTimeout);
  let requests = 0;
  const fetch = (async () => {
    const answer = answers[requests++];
    if (!answer) throw new Error('more requests than answers');
    if (answer.network_error) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: {
        'content-type': 'application/json',
        ...(answer.retry_after ? { 'retry-after': answer.retry_after } : {}),
      },
    });
  }) as typeof globalThis.fetch;
  const client = new Formfeed({
    apiKey: 'ff_test_k',
    fetch,
    timeoutMs: TIMEOUT_MS,
    maxRetries: retries.max_retries,
  });
  try {
    await client.request('GET', '/account');
    return { waits, requests, outcome: { ok: true } };
  } catch (error) {
    const e = error as FormfeedError;
    return {
      waits,
      requests,
      outcome: { error: { code: e.code, status: e.status } },
    };
  }
}

describe('retries', () => {
  afterEach(() => vi.restoreAllMocks());

  // the lowest jitter and the highest, so both ends of every wait's bounds are met
  describe.each([0, 0.999999])('with jitter %s', (jitter) => {
    it.each(retries.cases)('$name', async ({ answers, waits_ms, outcome }) => {
      const played = await play(answers, jitter);
      expect(played.outcome).toEqual(outcome);
      expect(played.requests).toBe(answers.length);
      expect(played.waits).toHaveLength(waits_ms.length);
      played.waits.forEach((wait, n) => {
        const [lowest, highest] = waits_ms[n] as [number, number];
        expect(wait).toBeGreaterThanOrEqual(lowest);
        expect(wait).toBeLessThanOrEqual(highest);
      });
    });
  });
});

describe('problems', () => {
  it.each(problems.cases)(
    '$name',
    async ({ status, headers, body, expect: want }) => {
      const fetch = (async () =>
        new Response(
          body === null
            ? null
            : typeof body === 'string'
              ? body
              : JSON.stringify(body),
          {
            status,
            headers: {
              'content-type':
                typeof body === 'string' ? 'text/plain' : 'application/json',
              ...headers,
            },
          },
        )) as typeof globalThis.fetch;
      const client = new Formfeed({
        apiKey: 'ff_test_k',
        fetch,
        maxRetries: 0,
      });
      const error = (await client
        .request('GET', '/account')
        .catch((e: unknown) => e)) as FormfeedError;
      expect(error).toBeInstanceOf(FormfeedError);
      expect({
        code: error.code,
        message: error.message,
        status: error.status,
        request_id: error.requestId,
      }).toEqual(want);
    },
  );
});
