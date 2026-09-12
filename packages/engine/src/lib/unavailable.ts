/**
 * Helpers that exist and compile, but cannot do their job yet. `analyze()` warns about them, so
 * the editor, `formfeed validate` and the importers say it instead of letting a render produce a
 * document with a broken image.
 *
 * Empty since the file library shipped (2026-09-12): `asset()` resolves against the workspace's
 * library now. The registry stays because it is the honest way to ship a helper whose backing
 * feature is not there yet - the editor shows the reason at the call site.
 */
const UNAVAILABLE: Record<string, string> = {};

/** The reason a helper cannot work yet, or `undefined` when it can. */
export function unavailableHelper(name: string): string | undefined {
  return UNAVAILABLE[name];
}
