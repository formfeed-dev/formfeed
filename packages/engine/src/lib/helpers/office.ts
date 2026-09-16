/** Helpers that return HTML and have no office form yet (spec 22 §4.4). */
export const officeUnsupportedHelpers: ReadonlySet<string> = new Set(['chart', 'markdown']);

/** The message those helpers fail with in office mode. */
export function officeUnsupported(name: string): string {
  return `${name}() is not supported in office templates`;
}
