import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Formfeed } from './client';

/**
 * The SDK's half of the operations table (plan 34, decision 9): `operations.json` names a method for
 * every operation of the API, or why there is none. `packages/api-types/src/lib/sdk-fixtures.spec.ts`
 * holds the names to the API; this holds them to the client, so a renamed method fails here.
 */
const map = JSON.parse(
  readFileSync(resolve(__dirname, '../../operations.json'), 'utf8'),
) as { operations: Record<string, string | { none: string }> };

const client = new Formfeed({
  apiKey: 'ff_test_k',
  fetch: (async () => new Response('{}')) as typeof fetch,
});

const named = Object.entries(map.operations).filter(
  (entry): entry is [string, string] => typeof entry[1] === 'string',
);

describe('operations.json', () => {
  it('names a method for most operations', () => {
    expect(named.length).toBeGreaterThan(50);
  });

  it.each(named)('%s is client.%s', (_operation, path) => {
    const target = path
      .split('.')
      .reduce<unknown>(
        (object, key) => (object as Record<string, unknown> | undefined)?.[key],
        client,
      );
    expect(typeof target).toBe('function');
  });
});
