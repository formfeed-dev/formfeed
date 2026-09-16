import { tokenize } from './xml';

/**
 * Loops copy paragraphs, and with them ids Word expects to be unique (spec 22 §4.3 step 7):
 *
 * - drawing ids (`wp:docPr`, `pic:cNvPr`, `p:cNvPr`) are renumbered past the highest in the part;
 * - bookmarks get new ids, their ends follow their starts, and repeated names get `_2`, `_3`;
 * - `w14:paraId` and `w14:textId` are removed from copies, and Word assigns new ones on save.
 *
 * The first occurrence keeps its values, so a part without loops comes out unchanged.
 */
const DRAWING_IDS = new Set(['wp:docPr', 'pic:cNvPr', 'p:cNvPr', 'a:cNvPr']);

export function makeIdsUnique(xml: string): string {
  const tokens = tokenize(xml);
  let highest = 0;
  for (const t of tokens)
    if (t.kind === 'open' && DRAWING_IDS.has(t.name)) highest = Math.max(highest, Number(attribute(t.raw, 'id')) || 0);

  // Per element: `wp:docPr` and `pic:cNvPr` of one drawing usually share a value, which is fine.
  const drawingIds = new Map<string, Set<string>>();
  const bookmarkIds = new Set<string>();
  const bookmarkNames = new Map<string, number>();
  const paragraphIds = new Set<string>();
  // A copied bookmark's end must follow its start's new id; ends come in the same order as starts.
  const pendingEnds = new Map<string, string[]>();
  let nextBookmark = 0;
  for (const t of tokens)
    if (t.kind === 'open' && t.name === 'w:bookmarkStart') nextBookmark = Math.max(nextBookmark, Number(attribute(t.raw, 'w:id')) || 0);

  let changed = false;
  const out = tokens.map((t) => {
    if (t.kind !== 'open') return t.raw;
    let raw = t.raw;
    if (DRAWING_IDS.has(t.name)) {
      const id = attribute(raw, 'id');
      if (id !== null) {
        const seen = drawingIds.get(t.name) ?? new Set<string>();
        drawingIds.set(t.name, seen);
        if (seen.has(id)) raw = setAttribute(raw, 'id', String(++highest));
        else seen.add(id);
      }
    } else if (t.name === 'w:bookmarkStart') {
      const id = attribute(raw, 'w:id');
      if (id !== null) {
        let newId = id;
        if (bookmarkIds.has(id)) {
          newId = String(++nextBookmark);
          raw = setAttribute(raw, 'w:id', newId);
        } else bookmarkIds.add(id);
        pendingEnds.set(id, [...(pendingEnds.get(id) ?? []), newId]);
      }
      const name = attribute(raw, 'w:name');
      if (name !== null) {
        const seen = bookmarkNames.get(name) ?? 0;
        bookmarkNames.set(name, seen + 1);
        if (seen > 0) raw = setAttribute(raw, 'w:name', `${name}_${seen + 1}`);
      }
    } else if (t.name === 'w:bookmarkEnd') {
      const id = attribute(raw, 'w:id');
      const queue = id === null ? undefined : pendingEnds.get(id);
      const newId = queue?.shift();
      if (newId !== undefined && newId !== id) raw = setAttribute(raw, 'w:id', newId);
    }
    if (t.name === 'w:p') {
      const paraId = attribute(raw, 'w14:paraId');
      if (paraId !== null) {
        if (paragraphIds.has(paraId)) raw = removeAttribute(removeAttribute(raw, 'w14:paraId'), 'w14:textId');
        else paragraphIds.add(paraId);
      }
    }
    if (raw !== t.raw) changed = true;
    return raw;
  });
  return changed ? out.join('') : xml;
}

function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${escape(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

function setAttribute(tag: string, name: string, value: string): string {
  return tag.replace(new RegExp(`(\\s${escape(name)}\\s*=\\s*)(?:"[^"]*"|'[^']*')`), `$1"${value}"`);
}

function removeAttribute(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${escape(name)}\\s*=\\s*(?:"[^"]*"|'[^']*')`), '');
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
