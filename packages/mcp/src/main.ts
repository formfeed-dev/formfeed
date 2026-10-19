import { startHttp, startStdio } from './lib/transports';

/**
 * `formfeed-mcp` (stdio, default) or `formfeed-mcp --http [--port 8790] [--host 0.0.0.0]`.
 * stdio takes FORMFEED_API_KEY and starts without it too, with the offline tools only; the HTTP
 * endpoint takes the key from each request.
 * FORMFEED_BASE_URL / FORMFEED_REGION select the API host.
 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const baseUrl = process.env['FORMFEED_BASE_URL'];
const region = process.env['FORMFEED_REGION'] as 'eu' | 'us' | undefined;
/** Supabase Auth as the OAuth server (`https://<ref>.supabase.co/auth/v1`) lets signed-in members in on `/mcp` and `/mcp/<workspace id>`. */
const authorizationServer =
  flag('--auth-server') ?? process.env['FORMFEED_AUTH_SERVER'];
const publicOrigin =
  flag('--public-origin') ?? process.env['FORMFEED_PUBLIC_ORIGIN'];

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'formfeed-mcp: Model Context Protocol server for Formfeed\n\n  formfeed-mcp              stdio; FORMFEED_API_KEY, without it the offline checks only\n  formfeed-mcp --http       Streamable HTTP on --port (8790) and --host (127.0.0.1); the key comes from Authorization: Bearer\n                            --auth-server <issuer> (or FORMFEED_AUTH_SERVER) also takes OAuth access tokens on /mcp and /mcp/<workspace id>;\n                            --public-origin <url> (or FORMFEED_PUBLIC_ORIGIN) is the origin clients see behind a proxy\n',
  );
} else if (args.includes('--http')) {
  startHttp({
    port: Number(flag('--port') ?? 8790),
    host: flag('--host') ?? '127.0.0.1',
    baseUrl,
    region,
    authorizationServer,
    publicOrigin,
  }).then((h) => process.stderr.write(`formfeed-mcp listening on ${h.url}\n`));
} else {
  // without a key the offline checks still work, so an agent can try them before anyone signs up
  const apiKey = process.env['FORMFEED_API_KEY'] || undefined;
  if (!apiKey)
    process.stderr.write(
      'FORMFEED_API_KEY is not set: only validate_template (with html) and check_invoice work\n',
    );
  startStdio({ apiKey, baseUrl, region }).catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
