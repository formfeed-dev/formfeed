import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createFormfeedServer } from './server';

/**
 * The hosted endpoint as a web-standard `fetch` handler (spec 10 §3.1), shared by the Cloudflare
 * Worker at `mcp.<domain>` and the Node server of `formfeed-mcp --http`. Stateless: every request
 * gets its own server bound to the credential of its `Authorization` header, and nothing is kept
 * between requests.
 *
 * Two ways in:
 * - `/mcp` with an API key, which carries its workspace.
 * - `/mcp/<workspace id>` with an OAuth access token from Supabase Auth, which carries a user; the
 *   URL names the workspace, the gateway checks the membership and cuts the token down to the MCP
 *   scopes. Without a token the answer is `401` with a `WWW-Authenticate` header that points at the
 *   protected-resource metadata, which is what makes an MCP client start the OAuth flow instead of
 *   asking for a key. The metadata names the authorization server; without one configured the
 *   workspace path is closed.
 */
export interface WebHandlerOptions {
  baseUrl?: string;
  region?: 'eu' | 'us';
  fetch?: typeof fetch;
  /**
   * The OAuth authorization server's issuer, Supabase Auth's `https://<ref>.supabase.co/auth/v1`
   * (RFC 8414 metadata lives under `/.well-known/oauth-authorization-server/auth/v1`). Unset: only
   * API keys on `/mcp`.
   */
  authorizationServer?: string;
  /** The origin clients see, when the handler runs behind a proxy that rewrites the host. */
  publicOrigin?: string;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_KEY = /^ff_(live|test)_/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type WebHandler = (request: Request) => Promise<Response>;

/** The paths the handler answers, so a host can mount it precisely. */
export const MCP_PATH = '/mcp';
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** RFC 9728 protected-resource metadata of one workspace endpoint. */
export function resourceMetadata(origin: string, workspaceId: string, authorizationServer: string): Record<string, unknown> {
  return {
    resource: `${origin}${MCP_PATH}/${workspaceId}`,
    authorization_servers: [authorizationServer.replace(/\/$/, '')],
    bearer_methods_supported: ['header'],
    // Supabase Auth accepts the OIDC identity scopes only; what the token may do is the gateway's decision
    scopes_supported: ['openid', 'email', 'profile'],
    resource_name: 'Formfeed',
    resource_documentation: 'https://docs.formfeed.dev/integrations/mcp',
  };
}

/** The `exp` of a JWT without verifying it: enough to send an expired token back for a refresh. */
export function tokenExpired(token: string, now = Date.now()): boolean {
  const part = token.split('.')[1] ?? '';
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && exp * 1000 <= now;
  } catch {
    return false;
  }
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function bearer(request: Request): string {
  const auth = request.headers.get('authorization') ?? '';
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
}

export function mcpFetchHandler(options: WebHandlerOptions = {}): WebHandler {
  const authorizationServer = options.authorizationServer?.replace(/\/$/, '');

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = (options.publicOrigin ?? url.origin).replace(/\/$/, '');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/healthz') return json({ ok: true }, 200);

    // RFC 9728: the metadata of a workspace endpoint, and of the bare path so a client that probes it learns the shape
    if (path === RESOURCE_METADATA_PATH || path.startsWith(`${RESOURCE_METADATA_PATH}${MCP_PATH}`)) {
      if (!authorizationServer) return json({ error: 'This endpoint takes API keys only; no authorization server is configured' }, 404);
      const workspaceId = path.slice(`${RESOURCE_METADATA_PATH}${MCP_PATH}/`.length);
      if (path === RESOURCE_METADATA_PATH || path === `${RESOURCE_METADATA_PATH}${MCP_PATH}`)
        return json(
          {
            resource: `${origin}${MCP_PATH}`,
            authorization_servers: [authorizationServer],
            bearer_methods_supported: ['header'],
            resource_name: 'Formfeed',
            resource_documentation: 'https://docs.formfeed.dev/integrations/mcp',
            // the OAuth resource is one workspace: add its id to the path
            formfeed_workspace_path: `${origin}${MCP_PATH}/{workspace_id}`,
          },
          200,
        );
      if (!WORKSPACE_ID.test(workspaceId)) return json({ error: 'The workspace id is not a UUID' }, 404);
      return json(resourceMetadata(origin, workspaceId, authorizationServer), 200);
    }

    if (path !== MCP_PATH && !path.startsWith(`${MCP_PATH}/`)) return new Response(null, { status: 404 });
    const workspaceId = path === MCP_PATH ? null : path.slice(MCP_PATH.length + 1);
    if (workspaceId !== null && !WORKSPACE_ID.test(workspaceId))
      return json({ error: `The path is /mcp for an API key or /mcp/<workspace id> for a signed-in member` }, 404);

    const credential = bearer(request);
    if (workspaceId === null) {
      // the API key path: any bearer the gateway accepts, but a token on this path lacks its workspace
      if (!credential) return json({ error: 'Authorization: Bearer <formfeed api key> required; a signed-in member connects to /mcp/<workspace id>' }, 401, { 'www-authenticate': 'Bearer realm="formfeed"' });
      if (!API_KEY.test(credential) && JWT.test(credential))
        return json({ error: 'An access token needs its workspace: connect to /mcp/<workspace id>' }, 401, { 'www-authenticate': 'Bearer realm="formfeed"' });
    } else {
      if (!authorizationServer) return json({ error: 'This endpoint takes API keys only; connect to /mcp with a key' }, 404);
      const metadata = `${origin}${RESOURCE_METADATA_PATH}${MCP_PATH}/${workspaceId}`;
      const challenge = (description: string) => ({
        'www-authenticate': `Bearer realm="formfeed", resource_metadata="${metadata}", error="invalid_token", error_description="${description}"`,
      });
      if (!credential || !JWT.test(credential)) return json({ error: 'Sign in: this endpoint takes an OAuth access token' }, 401, challenge('an access token is required'));
      if (tokenExpired(credential)) return json({ error: 'The access token expired' }, 401, challenge('the access token expired'));
    }

    const mcp = createFormfeedServer({
      apiKey: credential,
      ...(workspaceId ? { workspaceId } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.region ? { region: options.region } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    // JSON answers: the transport resolves once the reply is complete, so the server can go with the
    // response; an SSE stream would still be open when handleRequest returns.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      void mcp.close().catch(() => undefined);
    }
  };
}
