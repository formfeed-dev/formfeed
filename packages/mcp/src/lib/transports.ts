import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createFormfeedServer, type ServerOptions } from './server';

/** stdio for Claude Desktop, Cursor and friends: `FORMFEED_API_KEY=… formfeed-mcp`. */
export async function startStdio(options: ServerOptions): Promise<void> {
  // runs on the user's machine, so convert_to_pdf may read the user's files
  const server = createFormfeedServer({ localFiles: true, ...options });
  await server.connect(new StdioServerTransport());
}

export interface HttpOptions {
  port?: number;
  host?: string;
  baseUrl?: string;
  region?: 'eu' | 'us';
  fetch?: typeof fetch;
  path?: string;
}

export interface HttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Hosted Streamable HTTP endpoint (`mcp.<domain>/mcp`): stateless, one server per request bound to
 * the API key of the `Authorization: Bearer` header. No key, no session.
 */
export async function startHttp(options: HttpOptions = {}): Promise<HttpHandle> {
  const host = options.host ?? '127.0.0.1';
  const path = options.path ?? '/mcp';
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404);
      res.end();
      return;
    }
    const auth = req.headers.authorization ?? '';
    const apiKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!apiKey) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="formfeed"' });
      res.end(JSON.stringify({ error: 'Authorization: Bearer <formfeed api key> required' }));
      return;
    }
    const mcp = createFormfeedServer({ apiKey, baseUrl: options.baseUrl, region: options.region, fetch: options.fetch });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8790, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}${path}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
