import type { MarkdownTheme } from '../settings';
import { documentTheme } from './document';

/** The stylesheet of a theme; `none` has none, the print reset is all it gets. */
export function markdownThemeCss(theme: MarkdownTheme): string {
  return theme === 'document' ? documentTheme : '';
}
