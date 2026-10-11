import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INFO } from './server';

/**
 * The MCP Server Card (SEP-2127, final since 2026-10-06; the wire format is `schema.ts` of
 * modelcontextprotocol/experimental-ext-server-card): what a client may know about the endpoint
 * before it connects, which is identity, addresses and protocol versions, and no tools (those stay
 * with `tools/list`). Served at `<endpoint>/server-card`, the location the extension reserves, never
 * under `/.well-known/`, which the extension advises against; formfeed.dev's AI catalog
 * (`/.well-known/ai-catalog.json`) points at it. It says what the registry entry (`server.json`) says
 * about the remote endpoints, at the origin that serves it, and the spec holds the two together.
 */
export const SERVER_CARD_TYPE = 'application/mcp-server-card+json';
export const SERVER_CARD_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

export interface ServerCardRemote {
  type: 'streamable-http';
  url: string;
  headers?: Array<{
    name: string;
    description: string;
    isRequired: boolean;
    isSecret: boolean;
  }>;
  variables?: Record<string, { description: string; isRequired: boolean }>;
  supportedProtocolVersions: string[];
}

export interface ServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  title: string;
  websiteUrl: string;
  repository: { url: string; source: string; subfolder: string };
  icons: Array<{ src: string; mimeType: string; sizes?: string[] }>;
  remotes: ServerCardRemote[];
}

/**
 * The card of the endpoint at `origin`. `signIn` says whether an authorization server is configured:
 * without one the endpoint takes API keys only, so the key is required and there is no workspace
 * address.
 */
export function serverCard(origin: string, signIn: boolean): ServerCard {
  const endpoint = `${origin.replace(/\/$/, '')}/mcp`;
  const supportedProtocolVersions = [...SUPPORTED_PROTOCOL_VERSIONS];
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: 'io.github.formfeed-dev/formfeed',
    version: SERVER_INFO.version,
    description:
      'Render PDFs and images from templates, validate data and convert Office files to PDF.',
    title: 'Formfeed',
    websiteUrl: 'https://docs.formfeed.dev/integrations/mcp',
    repository: {
      url: 'https://github.com/formfeed-dev/formfeed',
      source: 'github',
      subfolder: 'packages/mcp',
    },
    icons: [
      { src: 'https://formfeed.dev/favicon.svg', mimeType: 'image/svg+xml' },
      {
        src: 'https://formfeed.dev/brand/formfeed-512.png',
        mimeType: 'image/png',
        sizes: ['512x512'],
      },
    ],
    remotes: [
      {
        type: 'streamable-http',
        url: endpoint,
        headers: [
          signIn
            ? {
                name: 'Authorization',
                description:
                  'Bearer followed by a Formfeed API key (ff_test_… or ff_live_…); without it the client signs in with your Formfeed account (OAuth) and you choose the workspace',
                isRequired: false,
                isSecret: true,
              }
            : {
                name: 'Authorization',
                description:
                  'Bearer followed by a Formfeed API key (ff_test_… or ff_live_…)',
                isRequired: true,
                isSecret: true,
              },
        ],
        supportedProtocolVersions,
      },
      ...(signIn
        ? [
            {
              type: 'streamable-http' as const,
              url: `${endpoint}/{workspace_id}`,
              variables: {
                workspace_id: {
                  description:
                    'Workspace id from the Formfeed app, for a connection that should work in another workspace than the one chosen at sign-in (OAuth)',
                  isRequired: true,
                },
              },
              supportedProtocolVersions,
            },
          ]
        : []),
    ],
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-expose-headers': 'ETag',
};

/**
 * The card as the extension's discovery rules ask for it: its media type, open CORS (it is public and
 * read-only), an hour of caching and an entity tag a client revalidates with `If-None-Match`.
 */
export async function serverCardResponse(
  request: Request,
  card: ServerCard,
): Promise<Response> {
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, {
      status: 405,
      headers: { ...CORS, allow: 'GET, HEAD, OPTIONS' },
    });
  const body = JSON.stringify(card, null, 2);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body),
  );
  const etag = `"${[...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}"`;
  const headers = {
    ...CORS,
    'cache-control': 'public, max-age=3600',
    etag,
  };
  const known = (request.headers.get('if-none-match') ?? '')
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''));
  if (known.includes(etag) || known.includes('*'))
    return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: { ...headers, 'content-type': SERVER_CARD_TYPE },
  });
}
