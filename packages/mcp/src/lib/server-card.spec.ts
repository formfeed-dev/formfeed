import { readFileSync } from 'node:fs';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INFO } from './server';
import {
  SERVER_CARD_SCHEMA,
  SERVER_CARD_TYPE,
  serverCard,
} from './server-card';
import { mcpFetchHandler } from './web';

const registry = JSON.parse(
  readFileSync(new URL('../../server.json', import.meta.url), 'utf8'),
) as Record<string, unknown> & { remotes: unknown[] };

const ORIGIN = 'https://mcp.formfeed.dev';
const handler = mcpFetchHandler({
  authorizationServer: 'https://abc.supabase.co/auth/v1',
  publicOrigin: ORIGIN,
});

describe('server card', () => {
  // the registry entry and the card describe the same hosted endpoint: a change to one is a change to both
  it('says what the registry entry says about the hosted endpoint', () => {
    const card = serverCard(ORIGIN, true);
    for (const field of [
      'name',
      'title',
      'description',
      'version',
      'websiteUrl',
      'repository',
      'icons',
    ] as const)
      expect([field, card[field]]).toEqual([field, registry[field]]);
    expect(
      card.remotes.map(
        ({ supportedProtocolVersions: _versions, ...remote }) => remote,
      ),
    ).toEqual(registry.remotes);
    expect(card.version).toBe(SERVER_INFO.version);
  });

  // the field rules of the extension's schema.ts (checked against its schema.json on 2026-10-11)
  it('keeps to the extension schema', () => {
    for (const card of [serverCard(ORIGIN, true), serverCard(ORIGIN, false)]) {
      expect(card.$schema).toBe(SERVER_CARD_SCHEMA);
      expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
      expect(card.description.length).toBeLessThanOrEqual(100);
      expect(card.title.length).toBeLessThanOrEqual(100);
      for (const remote of card.remotes) {
        expect(remote.url).toMatch(
          /^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/,
        );
        expect(remote.supportedProtocolVersions).toContain(
          LATEST_PROTOCOL_VERSION,
        );
      }
      // primitives stay with tools/list
      expect(Object.keys(card)).not.toContain('tools');
    }
  });

  it('asks for the key and names no workspace address without a sign-in', () => {
    const card = serverCard('http://localhost:8790/', false);
    expect(card.remotes).toHaveLength(1);
    expect(card.remotes[0]).toMatchObject({
      url: 'http://localhost:8790/mcp',
      headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
    });
  });

  it('is served beside the endpoint without a credential, cacheable and open to browsers', async () => {
    const res = await handler(
      new Request('https://internal.host/mcp/server-card', {
        headers: { accept: SERVER_CARD_TYPE },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(SERVER_CARD_TYPE);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toBe('ETag');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await res.json()).toEqual(serverCard(ORIGIN, true));

    const etag = res.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await handler(
      new Request(`${ORIGIN}/mcp/server-card/`, {
        headers: { 'if-none-match': `W/${etag}` },
      }),
    );
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);

    const head = await handler(
      new Request(`${ORIGIN}/mcp/server-card`, { method: 'HEAD' }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const preflight = await handler(
      new Request(`${ORIGIN}/mcp/server-card`, { method: 'OPTIONS' }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'If-None-Match',
    );
    const post = await handler(
      new Request(`${ORIGIN}/mcp/server-card`, { method: 'POST' }),
    );
    expect(post.status).toBe(405);
  });
});
