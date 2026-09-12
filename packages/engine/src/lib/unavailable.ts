/**
 * Helpers that exist and compile, but cannot do their job yet. `analyze()` warns about them, so
 * the editor, `formfeed validate` and the importers say it instead of letting a render produce a
 * document with a broken image.
 */
const UNAVAILABLE: Record<string, string> = {
  asset:
    'asset() needs the workspace asset library, which is not available yet, so the URL points nowhere. Use a full https URL or a data URI',
};

/** The reason a helper cannot work yet, or `undefined` when it can. */
export function unavailableHelper(name: string): string | undefined {
  return UNAVAILABLE[name];
}
