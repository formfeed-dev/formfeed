import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpFetchHandler, resourceMetadata, tokenExpired } from './web';

const WORKSPACE = 'f0000000-0000-4000-8000-000000000001';
const AUTH_SERVER = 'https://abc.supabase.co/auth/v1';

/** A token the handler lets through by shape and expiry; the fake API accepts anything. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}
const future = Math.floor(Date.now() / 1000) + 600;

function fakeApi() {
  const calls: Array<{ path: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ path: url.pathname, headers });
    if (url.pathname === '/v1/renders/rnd_1')
      return new Response(JSON.stringify({ id: 'rnd_1', status: 'succeeded', download_url: 'https://cdn.test/o/x.pdf', page_count: 1, units: 1, environment: 'live', template: null, error: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(JSON.stringify({ code: 'not_found', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Drives the handler in-process through the SDK's client transport. */
async function connect(handler: (r: Request) => Promise<Response>, url: string, authorization?: string): Promise<Client> {
  const client = new Client({ name: 'web-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      fetch: (input, init) => handler(new Request(input, init)),
      ...(authorization ? { requestInit: { headers: { authorization } } } : {}),
    }),
  );
  return client;
}

const structured = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent;

describe('mcpFetchHandler', () => {
  it('serves /mcp for API keys and sends the key to the API', async () => {
    const api = fakeApi();
    const handler = mcpFetchHandler({ baseUrl: 'https://api.test/v1', fetch: api.fetchImpl });
    const client = await connect(handler, 'https://mcp.test/mcp', 'Bearer ff_test_key');
    const result = structured(await client.callTool({ name: 'get_render', arguments: { id: 'rnd_1' } }));
    expect(result['status']).toBe('succeeded');
    const call = api.calls.find((c) => c.path === '/v1/renders/rnd_1');
    expect(call?.headers['authorization']).toBe('Bearer ff_test_key');
    expect(call?.headers['x-formfeed-workspace']).toBeUndefined();
    expect(call?.headers['user-agent']).toMatch(/^formfeed-mcp\//);
    await client.close();
  });

  it('refuses /mcp without a key, and a token on the key path', async () => {
    const handler = mcpFetchHandler({ authorizationServer: AUTH_SERVER });
    const none = await handler(new Request('https://mcp.test/mcp', { method: 'POST' }));
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="formfeed"');
    const token = await handler(new Request('https://mcp.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${jwt({ exp: future })}` } }));
    expect(token.status).toBe(401);
    expect(await token.json()).toMatchObject({ error: expect.stringContaining('/mcp/<workspace id>') });
    expect((await handler(new Request('https://mcp.test/nope'))).status).toBe(404);
    expect(await (await handler(new Request('https://mcp.test/healthz'))).json()).toEqual({ ok: true });
  });

  it('points a client without a token at the protected-resource metadata of the workspace (spec 10 §3.1)', async () => {
    const handler = mcpFetchHandler({ authorizationServer: AUTH_SERVER });
    const res = await handler(new Request(`https://mcp.test/mcp/${WORKSPACE}`, { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer realm="formfeed", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp/${WORKSPACE}", error="invalid_token", error_description="an access token is required"`,
    );
    const metadata = await handler(new Request(`https://mcp.test/.well-known/oauth-protected-resource/mcp/${WORKSPACE}`));
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual(resourceMetadata('https://mcp.test', WORKSPACE, AUTH_SERVER));
    expect(resourceMetadata('https://mcp.test', WORKSPACE, `${AUTH_SERVER}/`)).toMatchObject({
      resource: `https://mcp.test/mcp/${WORKSPACE}`,
      authorization_servers: [AUTH_SERVER],
      bearer_methods_supported: ['header'],
    });
    // the bare path's metadata tells a probing client where the workspace goes
    const bare = await handler(new Request('https://mcp.test/.well-known/oauth-protected-resource'));
    expect(await bare.json()).toMatchObject({ resource: 'https://mcp.test/mcp', formfeed_workspace_path: 'https://mcp.test/mcp/{workspace_id}' });
    // an API key on the workspace path is not an access token; a wrong id is not a workspace
    const key = await handler(new Request(`https://mcp.test/mcp/${WORKSPACE}`, { method: 'POST', headers: { authorization: 'Bearer ff_live_x' } }));
    expect(key.status).toBe(401);
    expect((await handler(new Request('https://mcp.test/mcp/not-a-uuid', { method: 'POST' }))).status).toBe(404);
    expect((await handler(new Request('https://mcp.test/.well-known/oauth-protected-resource/mcp/nope'))).status).toBe(404);
  });

  it('sends an expired token back for a refresh instead of a failing tool call', async () => {
    const handler = mcpFetchHandler({ authorizationServer: AUTH_SERVER });
    const expired = jwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const res = await handler(new Request(`https://mcp.test/mcp/${WORKSPACE}`, { method: 'POST', headers: { authorization: `Bearer ${expired}` } }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error_description="the access token expired"');
    expect(tokenExpired(expired)).toBe(true);
    expect(tokenExpired(jwt({ exp: future }))).toBe(false);
    expect(tokenExpired('not.a.jwt')).toBe(false);
  });

  it('acts for a signed-in member on /mcp/<workspace id>: the token and the workspace reach the API', async () => {
    const api = fakeApi();
    const handler = mcpFetchHandler({ baseUrl: 'https://api.test/v1', fetch: api.fetchImpl, authorizationServer: AUTH_SERVER });
    const token = jwt({ sub: 'user-1', client_id: 'client-1', exp: future });
    const client = await connect(handler, `https://mcp.test/mcp/${WORKSPACE}`, `Bearer ${token}`);
    const result = structured(await client.callTool({ name: 'get_render', arguments: { id: 'rnd_1' } }));
    expect(result['status']).toBe('succeeded');
    const call = api.calls.find((c) => c.path === '/v1/renders/rnd_1');
    expect(call?.headers).toMatchObject({ authorization: `Bearer ${token}`, 'x-formfeed-workspace': WORKSPACE });
    await client.close();
  });

  it('closes the workspace path while no authorization server is configured', async () => {
    const handler = mcpFetchHandler();
    const res = await handler(new Request(`https://mcp.test/mcp/${WORKSPACE}`, { method: 'POST', headers: { authorization: `Bearer ${jwt({ exp: future })}` } }));
    expect(res.status).toBe(404);
    expect((await handler(new Request(`https://mcp.test/.well-known/oauth-protected-resource/mcp/${WORKSPACE}`))).status).toBe(404);
  });

  it('uses the public origin behind a proxy', async () => {
    const handler = mcpFetchHandler({ authorizationServer: AUTH_SERVER, publicOrigin: 'https://mcp.formfeed.dev' });
    const res = await handler(new Request(`http://127.0.0.1:8790/mcp/${WORKSPACE}`, { method: 'POST' }));
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="https://mcp.formfeed.dev/.well-known/oauth-protected-resource/mcp/${WORKSPACE}"`);
  });
});
