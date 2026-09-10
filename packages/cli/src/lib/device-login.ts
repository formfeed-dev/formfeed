import { CliError, exitCodes } from './errors';

/**
 * Device authorisation against `POST /v1/auth/device` (spec 15 §3). The CLI shows a short code,
 * the person approves it in the browser, and the gateway hands over a workspace API key.
 */
export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceApproval {
  api_key: string;
  workspace: { id: string; slug: string; name: string; region: string };
  organization: { id: string; slug: string; name: string };
}

export interface DeviceLoginOptions {
  baseUrl: string;
  clientName: string;
  fetch: typeof fetch;
  /** Called once the code is known, so the command can print it and open the browser. */
  onCode: (start: DeviceStart) => void | Promise<void>;
  /** Injected in tests; defaults to real waiting. */
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readProblem(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `HTTP ${response.status}`;
}

export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceApproval> {
  const base = options.baseUrl.replace(/\/$/, '');
  const wait = options.wait ?? sleep;
  const now = options.now ?? (() => Date.now());

  const startResponse = await options.fetch(`${base}/auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: options.clientName }),
  });
  if (!startResponse.ok)
    throw new CliError(`Could not start the login: ${await readProblem(startResponse)}`, exitCodes.network);
  const start = (await startResponse.json()) as DeviceStart;
  await options.onCode(start);

  const deadline = now() + start.expires_in * 1000;
  let interval = Math.max(start.interval, 1) * 1000;
  for (;;) {
    await wait(interval);
    const response = await options.fetch(`${base}/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    if (response.status === 200) return (await response.json()) as DeviceApproval;
    if (response.status === 202) {
      const body = (await response.json().catch(() => ({}))) as { interval?: number };
      if (body.interval) interval = Math.max(body.interval, 1) * 1000;
      if (now() >= deadline)
        throw new CliError('The code expired before it was approved; run formfeed login again', exitCodes.auth);
      continue;
    }
    if (response.status === 403)
      throw new CliError('The request was refused in the browser', exitCodes.auth);
    throw new CliError(await readProblem(response), exitCodes.auth);
  }
}
