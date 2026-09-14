import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join } from 'node:path';
import type { ListenSession } from '@formfeed/sdk-ts';
import { CliError, exitCodes } from './errors';

/**
 * `formfeed listen` (spec 20 §2): a listen session relays the workspace's webhook deliveries over a
 * WebSocket; the CLI posts each one to a local URL and answers with the local status code.
 */

/** The part of the WHATWG WebSocket the CLI uses; Node 22's global `WebSocket` and test fakes both fit. */
export interface WebSocketLike {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type Connect = (url: string) => WebSocketLike;

/** Close codes of the relay: the session was ended from the app, or a newer connection took it over. */
export const closeCodes = { ended: 4000, replaced: 4001 } as const;

export interface RelayedDelivery {
  type: 'delivery';
  id: string;
  headers: Record<string, string>;
  body: string;
}

export interface ForwardResult {
  status: number;
  ms: number;
  error?: string;
}

export const defaultConnect: Connect = (url) => {
  const Impl = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Impl)
    throw new CliError(`formfeed listen needs a WebSocket client, which Node.js has built in from version 22 (this is ${process.version})`, exitCodes.usage);
  return new Impl(url);
};

/**
 * Posts the relayed body unchanged with the relayed headers. Plain `node:http(s)` rather than fetch, so
 * `--skip-verify` can turn off certificate checks for this one request (a local server with a
 * self-signed certificate) without touching TLS for the API connection or setting a process-wide
 * `NODE_TLS_REJECT_UNAUTHORIZED`. Never throws: an unreachable server is status 0 with the error.
 */
export function forwardDelivery(
  target: string,
  delivery: Pick<RelayedDelivery, 'headers' | 'body'>,
  options: { skipVerify?: boolean; timeoutMs?: number } = {},
): Promise<ForwardResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      resolve({ status: 0, ms: 0, error: `invalid URL ${target}` });
      return;
    }
    const body = Buffer.from(delivery.body, 'utf8');
    const headers: Record<string, string | number> = { ...delivery.headers, 'content-length': body.length };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      url,
      { method: 'POST', headers, ...(url.protocol === 'https:' && options.skipVerify ? { rejectUnauthorized: false } : {}) },
      (res) => {
        // the status is all the relay needs; drain the body so the socket is released
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: elapsed() }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0, ms: elapsed() }));
      },
    );
    req.setTimeout(options.timeoutMs ?? 8000, () => req.destroy(new Error(`no answer within ${Math.round((options.timeoutMs ?? 8000) / 1000)} s`)));
    // Node's messages name the code already ("connect ECONNREFUSED 127.0.0.1:3000")
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ status: 0, ms: elapsed(), error: e.message || e.code || 'request failed' }));
    req.end(body);
  });
}

/** Event type, the render or job id and the event id from a delivery body (the event envelope). */
export function describeDelivery(body: string): { event: string; object: string | null; eventId: string | null } {
  try {
    const parsed = JSON.parse(body) as { id?: unknown; type?: unknown; data?: { id?: unknown } | null };
    return {
      event: typeof parsed.type === 'string' ? parsed.type : 'unknown',
      object: typeof parsed.data?.id === 'string' ? parsed.data.id : null,
      eventId: typeof parsed.id === 'string' ? parsed.id : null,
    };
  } catch {
    return { event: 'unknown', object: null, eventId: null };
  }
}

export function clockTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** `12:04:11  render.completed  rnd_8Hk2  → 200 (41 ms)  evt_1` */
export function deliveryLine(at: Date, body: string, attempt: string | undefined, result: ForwardResult): string {
  const { event, object, eventId } = describeDelivery(body);
  const outcome = result.status === 0 ? `→ failed: ${result.error ?? 'no answer'}` : `→ ${result.status} (${result.ms} ms)`;
  const retry = attempt && Number(attempt) > 1 ? `  attempt ${attempt}` : '';
  return `${clockTime(at)}  ${event.padEnd(16)}  ${object ?? '-'}  ${outcome}${retry}${eventId ? `  ${eventId}` : ''}`;
}

// --- the running session, for `formfeed webhooks resend` ------------------------------------------

export interface ListenState {
  session_id: string;
  pid: number;
  forward_to: string;
  started_at: string;
}

/**
 * Where a running `formfeed listen` records its session: next to the user config, one file per API key
 * (a hash of it, never the key), because a session belongs to a key and `resend` must use the same one
 * from any directory.
 */
export function listenStatePath(configPath: string, apiKey: string): string {
  const hash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return join(dirname(configPath), 'listen', `${hash}.json`);
}

export function writeListenState(path: string, state: ListenState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function removeListenState(path: string, sessionId?: string): void {
  // a newer listen of the same key may have written its own session meanwhile
  if (sessionId && readListenState(path, false)?.session_id !== sessionId) return;
  rmSync(path, { force: true });
}

/** The recorded session, or null when there is none or its process is gone. */
export function readListenState(path: string, requireAlive = true): ListenState | null {
  if (!existsSync(path)) return null;
  let state: ListenState;
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) as ListenState;
  } catch {
    return null;
  }
  if (!state.session_id) return null;
  if (requireAlive && !processAlive(state.pid)) return null;
  return state;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// --- the socket loop --------------------------------------------------------------------------------

export type SocketOutcome =
  | { kind: 'ended'; reason: string }
  | { kind: 'replaced' }
  | { kind: 'dropped'; code: number | null; ready: boolean; error?: string }
  | { kind: 'interrupted' };

export interface SocketHandlers {
  onReady: () => void;
  onDelivery: (delivery: RelayedDelivery) => Promise<ForwardResult>;
}

/**
 * Runs one WebSocket connection until it closes or `signal` aborts. Deliveries are forwarded
 * concurrently, each answered with `{type:'result'}` as soon as the local server answers.
 */
export function runSocket(socket: WebSocketLike, handlers: SocketHandlers, signal: AbortSignal): Promise<SocketOutcome> {
  return new Promise((resolve) => {
    let ready = false;
    let endedReason: string | null = null;
    let lastError: string | undefined;
    let settled = false;
    const finish = (outcome: SocketOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      try {
        socket.close(1000, 'formfeed listen stopped');
      } catch {
        // closing a socket that never opened
      }
      finish({ kind: 'interrupted' });
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);

    socket.addEventListener('message', (event) => {
      let message: { type?: string; reason?: string; id?: unknown; headers?: Record<string, string>; body?: string };
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'ready') {
        ready = true;
        handlers.onReady();
      } else if (message.type === 'ended') {
        endedReason = message.reason ?? 'ended';
      } else if (message.type === 'delivery' && typeof message.id === 'string') {
        const delivery: RelayedDelivery = { type: 'delivery', id: message.id, headers: message.headers ?? {}, body: message.body ?? '' };
        void handlers.onDelivery(delivery).then((result) => {
          if (settled) return;
          try {
            socket.send(JSON.stringify({ type: 'result', id: delivery.id, status: result.status, ms: result.ms, ...(result.error ? { error: result.error } : {}) }));
          } catch {
            // the socket closed while the local server answered; the relay times the delivery out
          }
        });
      }
    });
    socket.addEventListener('error', (event) => {
      lastError = (event as { message?: string }).message ?? 'WebSocket error';
    });
    socket.addEventListener('close', (event) => {
      const code = event.code ?? null;
      if (code === closeCodes.ended || endedReason !== null) finish({ kind: 'ended', reason: endedReason ?? event.reason ?? 'ended' });
      else if (code === closeCodes.replaced) finish({ kind: 'replaced' });
      else finish({ kind: 'dropped', code, ready, ...(lastError ? { error: lastError } : {}) });
    });
  });
}

/** Seconds to wait before reconnect attempt `n` (1, 2, 4 … 30). */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export function environmentsLabel(session: Pick<ListenSession, 'environments'>): string {
  const envs = session.environments?.length ? session.environments : ['test'];
  return envs.length === 2 ? 'live- and test' : envs.join(' and ');
}

export interface ListenRun {
  /** Starts a session (`POST /webhooks/listen`); called again after a dropped connection. */
  start: () => Promise<ListenSession>;
  /** Ends a session (`DELETE /webhooks/listen/{id}`). */
  end: (id: string) => Promise<void>;
  connect: Connect;
  forwardTo: string;
  skipVerify: boolean;
  json: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  signal: AbortSignal;
  wait: (ms: number) => Promise<void>;
  now: () => Date;
  /** Where the running session is recorded for `webhooks resend`. */
  statePath: string;
  workspaceName: string | null;
  /** Consecutive connection failures without a `ready` before giving up. */
  maxFailures?: number;
}

/**
 * The session loop. A relay connection needs a fresh ticket, and a ticket comes only with a new
 * session (which ends the previous session of the key; the server keeps the key's signing secret), so a
 * dropped socket is answered with a new session after a backoff, and a changed secret is printed where it cannot be missed.
 * Close 4000 (ended in the app) ends the command; 4001 (another listen of the key took over) fails it.
 */
export async function runListen(o: ListenRun): Promise<void> {
  const maxFailures = o.maxFailures ?? 8;
  const info = (line: string, data: Record<string, unknown>) => (o.json ? o.out(JSON.stringify(data)) : o.out(line));
  let session = await o.start();
  let reconnected = false;
  let lastSecret = session.secret;
  let failures = 0;
  const record = () => writeListenState(o.statePath, { session_id: session.id, pid: process.pid, forward_to: o.forwardTo, started_at: o.now().toISOString() });
  record();
  const endQuietly = (id: string) => o.end(id).catch(() => undefined);

  try {
    for (;;) {
      let outcome: SocketOutcome;
      try {
        const socket = o.connect(session.websocket_url);
        outcome = await runSocket(
          socket,
          {
            onReady: () => {
              failures = 0;
              const where = o.workspaceName ? `workspace "${o.workspaceName}"` : 'the workspace';
              const data = {
                type: 'ready',
                reconnected,
                session_id: session.id,
                secret: session.secret,
                forward_to: o.forwardTo,
                events: session.events,
                environments: session.environments,
              };
              if (o.json) o.out(JSON.stringify(data));
              else if (reconnected) {
                // the server keeps a key's secret across sessions; say so only if it did change
                o.out(
                  session.secret === lastSecret
                    ? 'Reconnected with a new session; the signing secret is unchanged.'
                    : `Reconnected with a new session. The signing secret changed, update your server: ${session.secret}`,
                );
              } else {
                o.out(`Ready. Forwarding ${environmentsLabel(session)}-environment events of ${where} to ${o.forwardTo}`);
                o.out(`Webhook signing secret: ${session.secret}  (kept for this API key across listen sessions)`);
                o.out('');
              }
            },
            onDelivery: async (delivery) => {
              const at = o.now();
              const result = await forwardDelivery(o.forwardTo, delivery, { skipVerify: o.skipVerify });
              const { event, object, eventId } = describeDelivery(delivery.body);
              const attempt = delivery.headers['webhook-attempt'];
              info(deliveryLine(at, delivery.body, attempt, result), {
                type: 'delivery',
                time: at.toISOString(),
                delivery_id: delivery.id,
                event_id: eventId,
                event,
                object_id: object,
                attempt: attempt ? Number(attempt) : null,
                status: result.status,
                ms: result.ms,
                ...(result.error ? { error: result.error } : {}),
              });
              return result;
            },
          },
          o.signal,
        );
      } catch (e) {
        if (e instanceof CliError) throw e;
        outcome = { kind: 'dropped', code: null, ready: false, error: e instanceof Error ? e.message : String(e) };
      }

      if (outcome.kind === 'interrupted') {
        await endQuietly(session.id);
        o.err('Stopped listening; the session is ended.');
        return;
      }
      if (outcome.kind === 'ended') {
        o.err(`The listen session was ended in the app (${outcome.reason}).`);
        return;
      }
      if (outcome.kind === 'replaced')
        throw new CliError('Another `formfeed listen` with the same API key took over this session.', exitCodes.usage);

      failures = outcome.ready ? 1 : failures + 1;
      if (failures > maxFailures) {
        await endQuietly(session.id);
        throw new CliError(`Could not keep a connection to the webhook relay${outcome.error ? `: ${outcome.error}` : ''}`, exitCodes.network);
      }
      const delay = reconnectDelayMs(failures);
      o.err(`Connection to the relay lost${outcome.code ? ` (close code ${outcome.code})` : ''}${outcome.error ? `: ${outcome.error}` : ''}; reconnecting in ${Math.round(delay / 1000)} s with a new session…`);
      if (!(await abortableWait(o.wait, delay, o.signal))) {
        await endQuietly(session.id);
        o.err('Stopped listening; the session is ended.');
        return;
      }
      lastSecret = session.secret;
      session = await startWithRetry(o, failures, maxFailures);
      if (o.signal.aborted) {
        await endQuietly(session.id);
        return;
      }
      reconnected = true;
      record();
    }
  } finally {
    removeListenState(o.statePath, session.id);
  }
}

/** Starting a session again after a drop: network trouble backs off, a refusal (auth, limit) ends the command. */
async function startWithRetry(o: ListenRun, failures: number, maxFailures: number): Promise<ListenSession> {
  for (let attempt = failures; ; attempt++) {
    try {
      return await o.start();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if ((status > 0 && status < 500 && status !== 429) || attempt >= maxFailures) throw e;
      const delay = reconnectDelayMs(attempt + 1);
      o.err(`Starting a new session failed (${e instanceof Error ? e.message : String(e)}); retrying in ${Math.round(delay / 1000)} s…`);
      if (!(await abortableWait(o.wait, delay, o.signal))) throw new CliError('Stopped listening.', exitCodes.ok, { silent: true });
    }
  }
}

/** Resolves true after `ms`, false as soon as `signal` aborts. */
function abortableWait(wait: (ms: number) => Promise<void>, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void wait(ms).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted);
    });
  });
}
