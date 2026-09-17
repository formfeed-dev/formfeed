import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFormfeedServer, type ServerOptions } from './server';
import { MCP_PATH, mcpFetchHandler, type WebHandlerOptions } from './web';

/** stdio for Claude Desktop, Cursor and friends: `FORMFEED_API_KEY=… formfeed-mcp`. */
export async function startStdio(options: ServerOptions): Promise<void> {
  // runs on the user's machine, so convert_to_pdf may read the user's files
  const server = createFormfeedServer({ localFiles: true, ...options });
  await server.connect(new StdioServerTransport());
}

export interface HttpOptions extends WebHandlerOptions {
  port?: number;
  host?: string;
}

export interface HttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Hosted Streamable HTTP endpoint (`mcp.<domain>/mcp`) on Node: the web-standard handler behind
 * `node:http`. Stateless, one server per request bound to the credential of the `Authorization`
 * header; `/mcp/<workspace id>` takes OAuth access tokens once `authorizationServer` is set.
 */
export async function startHttp(options: HttpOptions = {}): Promise<HttpHandle> {
  const host = options.host ?? '127.0.0.1';
  const { port: _port, host: _host, ...handlerOptions } = options;
  void _port;
  void _host;
  const handler = mcpFetchHandler(handlerOptions);
  const server: Server = createServer((req, res) => {
    void toRequest(req, host)
      .then(handler)
      .then((response) => send(response, res))
      .catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8790, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}${MCP_PATH}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A web-standard Request from Node's message; the body is read in full, MCP messages are small. */
async function toRequest(req: IncomingMessage, host: string): Promise<Request> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(Buffer.concat(chunks));
  return new Request(url, { method, headers, ...(body ? { body } : {}) });
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = name === 'set-cookie' ? [...(headers[name] ?? []), value] : value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}
