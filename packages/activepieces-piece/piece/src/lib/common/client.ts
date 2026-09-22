import { HttpError, HttpMethod, httpClient } from '@activepieces/pieces-common';
import { isFinished } from './utils';

export const BASE_URL = 'https://api.formfeed.dev/v1';

/** A synchronous render that outlives the gateway's wait answers 202; the actions poll it then. */
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export interface Render {
  id: string;
  status: string;
  output?: string;
  download_url?: string | null;
  page_count?: number | null;
  error?: { title?: string; detail?: string; code?: string } | null;
  [key: string]: unknown;
}

/** The API key of a connection: the wrapped value actions get, or the raw one `validate` gets. */
export function apiKeyOf(auth: unknown): string {
  if (typeof auth === 'string') return auth;
  const wrapped = auth as { secret_text?: string } | undefined;
  if (wrapped?.secret_text) return wrapped.secret_text;
  throw new Error('Connect a Formfeed account first');
}

export interface ApiRequest {
  auth: unknown;
  method?: HttpMethod;
  path: string;
  body?: unknown;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * One authenticated call to the Formfeed API. A problem answer becomes an error that names the
 * status, the detail and the code, so a flow's error branch can route on them.
 */
export async function formfeedRequest<T>(request: ApiRequest): Promise<T> {
  try {
    const response = await httpClient.sendRequest<T>({
      method: request.method ?? HttpMethod.GET,
      url: `${BASE_URL}${request.path}`,
      headers: { ...request.headers, Authorization: `Bearer ${apiKeyOf(request.auth)}` },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.queryParams ? { queryParams: request.queryParams } : {}),
    });
    return response.body;
  } catch (error) {
    throw problemError(error);
  }
}

/** `[404] No published template "x" (template_not_found)` from an HttpError of a problem answer. */
export function problemError(error: unknown): Error {
  if (!(error instanceof HttpError)) return error instanceof Error ? error : new Error(String(error));
  // the fetch client of newer framework releases hands the body over as text
  const raw = error.response.body;
  let body: { detail?: string; title?: string; code?: string } | undefined;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      body = { detail: raw };
    }
  } else body = raw as typeof body;
  const text = body?.detail || body?.title || 'Request failed';
  return new Error(`[${error.response.status}] ${text}${body?.code ? ` (${body.code})` : ''}`);
}

/** Reads a render back until it has finished, for at most five minutes. */
export async function waitForRender(auth: unknown, render: Render): Promise<Render> {
  let current = render;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!isFinished(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await formfeedRequest<Render>({ auth, path: `/renders/${encodeURIComponent(current.id)}` });
  }
  return current;
}

/** The bytes behind a signed download URL; the key is not sent there. */
export async function downloadBytes(url: string): Promise<Buffer> {
  const response = await httpClient.sendRequest<ArrayBuffer>({
    method: HttpMethod.GET,
    url,
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.body);
}
