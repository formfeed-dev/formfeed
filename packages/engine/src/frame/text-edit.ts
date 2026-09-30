/**
 * The edit session inside a preview frame (plan 16 §3.3). Bundled by `engine:frames` into
 * `lib/generated/frames.ts` and injected into the flow and paged previews while the editor's edit
 * mode is on, so it must stay self-contained: no imports but types, nothing from module scope that a
 * bundler would not inline.
 *
 * A click on an element marked `data-ff-edit` asks the editor (`formfeed:edit-request`); the editor
 * answers with the items to show (`formfeed:edit-begin`) or a refusal. While editing, text is typed
 * in place, chips are atomic, and Enter, Tab or leaving the element commit
 * (`formfeed:edit-commit`), Escape cancels. The frame never writes the template: it only sends what
 * the user typed.
 */

/** An item as the frame shows it: chips carry the text to display. */
export type FrameItem =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; index: number; text: string; title?: string }
  | { kind: 'break' };

/** What the frame sends back: chips by index only. */
export type FrameEditItem =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; index: number }
  | { kind: 'break' };

export interface EditBegin {
  type: 'formfeed:edit-begin';
  token: string;
  src: string;
  /** A design layer instead of a source position: its `.ff-text` is edited (the canvas, plan 16 §4.6). */
  layer?: string;
  items: FrameItem[];
  allowBreaks: boolean;
  /** Shown beside the element while editing ("Changes all 12"). */
  note?: string;
  label?: string;
}

interface Session {
  token: string;
  element: HTMLElement;
  saved: Node[];
  allowBreaks: boolean;
  badge: HTMLElement | null;
  done: boolean;
}

const style = `
html.ff-edit-mode [data-ff-edit] { cursor: text; }
html.ff-edit-mode [data-ff-edit]:hover { outline: 1px dashed rgba(37,99,235,.85); outline-offset: 2px; }
html.ff-edit-mode [data-ff-edit="t"]:hover { outline-color: rgba(147,51,234,.9); }
.ff-editing { outline: 2px solid #2563eb !important; outline-offset: 2px; cursor: text; }
.ff-editing .ff-chip { background: rgba(37,99,235,.14) !important; box-shadow: inset 0 0 0 1px rgba(37,99,235,.45) !important; border-radius: 3px !important; padding: 0 1px !important; cursor: default; }
.ff-edit-badge { position: absolute; z-index: 2147483647; font: 500 11px/1.4 system-ui, sans-serif !important; color: #fff !important; background: #2563eb !important; padding: 1px 6px !important; border-radius: 4px !important; pointer-events: none; white-space: nowrap; }
`;

export interface TextEditOptions {
  /**
   * The preview's edit mode: a click on marked text asks the editor, and undo keys are forwarded.
   * The design stage starts sessions itself (its frame takes no pointer events), so it turns this off.
   */
  clicks?: boolean;
  /**
   * The design stage: report the items on every change (`formfeed:edit-input`), so what was typed
   * survives a frame that goes away before its session commits (the stage is rebuilt when the editor
   * switches panels, and the commit would reach no one).
   */
  live?: boolean;
}

export function installTextEdit(
  win: Window,
  options: TextEditOptions = {},
): void {
  const clicks = options.clicks !== false;
  const live = options.live === true;
  const doc = win.document;
  let session: Session | null = null;
  let pending: {
    src: string;
    element: HTMLElement;
    x: number;
    y: number;
  } | null = null;
  const say = (message: Record<string, unknown>) => {
    try {
      win.parent.postMessage(message, '*');
    } catch {
      // the editor is gone
    }
  };

  const sheet = doc.createElement('style');
  sheet.setAttribute('data-formfeed', 'edit');
  // Paged.js rewrites every stylesheet it finds unless told not to
  sheet.setAttribute('data-pagedjs-ignore', '');
  sheet.textContent = style;
  (doc.head ?? doc.documentElement).appendChild(sheet);
  if (clicks) doc.documentElement.classList.add('ff-edit-mode');

  const editableOf = (target: EventTarget | null): HTMLElement | null => {
    // a text node or the document has no `closest`; `instanceof` would need the frame's own Element
    const element =
      target && typeof (target as Element).closest === 'function'
        ? (target as Element)
        : null;
    return (element?.closest('[data-ff-edit]') as HTMLElement | null) ?? null;
  };

  doc.addEventListener(
    'click',
    (event) => {
      if (!clicks) return;
      if (
        session &&
        !session.done &&
        session.element.contains(event.target as Node)
      ) {
        // clicks inside the element place the caret; nothing else hears them
        event.stopImmediatePropagation();
        return;
      }
      const element = editableOf(event.target);
      if (!element) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (session && !session.done) commit();
      const src = element.getAttribute('data-ff-src') ?? '';
      const rect = element.getBoundingClientRect();
      pending = { src, element, x: event.clientX, y: event.clientY };
      say({
        type: 'formfeed:edit-request',
        src,
        edit: element.getAttribute('data-ff-edit'),
        text: element.textContent ?? '',
        count: doc.querySelectorAll(`[data-ff-src="${src.replace(/"/g, '')}"]`)
          .length,
        split:
          element.hasAttribute('data-split-from') ||
          element.hasAttribute('data-split-to'),
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      });
    },
    true,
  );

  // undo and redo of committed edits belong to the editor; the frame's keys never reach it
  doc.addEventListener('keydown', (event) => {
    if (!clicks || (session && !session.done)) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z' || key === 'y') {
      event.preventDefault();
      say({
        type: key === 'y' || event.shiftKey ? 'formfeed:redo' : 'formfeed:undo',
      });
    }
  });

  win.addEventListener('message', (event) => {
    if (event.source !== win.parent) return;
    const data = event.data as { type?: string } | null;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'formfeed:edit-begin') begin(data as EditBegin);
    else if (
      data.type === 'formfeed:edit-refuse' ||
      data.type === 'formfeed:edit-end'
    ) {
      pending = null;
      if (session && !session.done) cancel(false);
    }
  });

  function begin(message: EditBegin): void {
    if (session && !session.done) cancel(false);
    const element = message.layer
      ? (doc.querySelector(
          `[data-ff-layer="${String(message.layer).replace(/"/g, '')}"] > .ff-text`,
        ) as HTMLElement | null)
      : pending && pending.src === message.src
        ? pending.element
        : (doc.querySelector(
            `[data-ff-src="${String(message.src).replace(/"/g, '')}"]`,
          ) as HTMLElement | null);
    const point =
      !message.layer && pending && pending.src === message.src ? pending : null;
    pending = null;
    // the editor holds its render and its gestures until a session ends: say so when none starts (the
    // element is not in this document, say a layer added after it was rendered)
    if (!element || !Array.isArray(message.items)) {
      say({ type: 'formfeed:edit-cancel', token: String(message.token) });
      return;
    }
    const saved = Array.from(element.childNodes);
    const fragment = doc.createDocumentFragment();
    for (const item of message.items) {
      if (item.kind === 'text')
        fragment.appendChild(doc.createTextNode(String(item.text)));
      else if (item.kind === 'break')
        fragment.appendChild(doc.createElement('br'));
      else if (item.kind === 'chip') {
        const chip = doc.createElement('span');
        chip.className = 'ff-chip';
        chip.setAttribute('data-ff-chip', String(item.index));
        chip.setAttribute('contenteditable', 'false');
        if (item.title) chip.title = String(item.title);
        chip.textContent = String(item.text);
        fragment.appendChild(chip);
      }
    }
    for (const node of saved) element.removeChild(node);
    element.appendChild(fragment);
    element.contentEditable = 'true';
    element.classList.add('ff-editing');
    element.setAttribute('role', 'textbox');
    if (message.label)
      element.setAttribute('aria-label', String(message.label));
    element.spellcheck = true;
    session = {
      token: String(message.token),
      element,
      saved,
      allowBreaks: message.allowBreaks === true,
      badge: message.note ? badgeFor(element, String(message.note)) : null,
      done: false,
    };
    element.addEventListener('keydown', onKey);
    element.addEventListener('beforeinput', onBeforeInput);
    element.addEventListener('paste', onPaste);
    element.addEventListener('drop', onDrop);
    element.addEventListener('focusout', onFocusOut);
    if (live) element.addEventListener('input', onInput);
    element.focus();
    placeCaret(element, point);
    say({ type: 'formfeed:edit-started', token: session.token });
  }

  function onInput(): void {
    if (session && !session.done)
      say({
        type: 'formfeed:edit-input',
        token: session.token,
        items: serialize(session.element),
      });
  }

  function badgeFor(element: HTMLElement, note: string): HTMLElement {
    const badge = doc.createElement('div');
    badge.className = 'ff-edit-badge';
    badge.textContent = note;
    const rect = element.getBoundingClientRect();
    badge.style.left = `${rect.left + win.scrollX}px`;
    badge.style.top = `${Math.max(0, rect.top + win.scrollY - 22)}px`;
    doc.body.appendChild(badge);
    return badge;
  }

  function placeCaret(
    element: HTMLElement,
    point: { x: number; y: number } | null,
  ): void {
    const selection = win.getSelection();
    if (!selection) return;
    let range: Range | null = null;
    const withCaret = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    if (point) {
      if (withCaret.caretRangeFromPoint)
        range = withCaret.caretRangeFromPoint(point.x, point.y);
      else if (withCaret.caretPositionFromPoint) {
        const position = withCaret.caretPositionFromPoint(point.x, point.y);
        if (position) {
          range = doc.createRange();
          range.setStart(position.offsetNode, position.offset);
        }
      }
    }
    if (!range || !element.contains(range.startContainer)) {
      range = doc.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function onKey(event: KeyboardEvent): void {
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      cancel(true);
    } else if (key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      commit();
    } else if (key === 'Enter') {
      event.preventDefault();
      if (session?.allowBreaks) insertBreak();
    } else if (key === 'Tab') {
      event.preventDefault();
      commit();
    } else if (
      (event.ctrlKey || event.metaKey) &&
      ['b', 'i', 'u'].includes(key.toLowerCase())
    ) {
      // Firefox fires no beforeinput for these (spike A0)
      event.preventDefault();
    }
  }

  function onBeforeInput(event: InputEvent): void {
    const type = event.inputType ?? '';
    if (
      type.startsWith('format') ||
      type === 'insertFromDrop' ||
      type === 'insertParagraph' ||
      type === 'insertLineBreak'
    )
      event.preventDefault();
  }

  function onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const text = (event.clipboardData?.getData('text/plain') ?? '').replace(
      /\r\n?|\n/g,
      ' ',
    );
    if (!doc.execCommand('insertText', false, text)) {
      const selection = win.getSelection();
      const range =
        selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      if (range) {
        range.deleteContents();
        range.insertNode(doc.createTextNode(text));
        range.collapse(false);
      }
    }
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
  }

  function onFocusOut(): void {
    // the caret moving onto a chip is not leaving; focus going to the editor is, although this
    // document's active element stays where it was when its window loses focus
    win.setTimeout(() => {
      if (
        session &&
        !session.done &&
        (!doc.hasFocus() || !session.element.contains(doc.activeElement))
      )
        commit();
    }, 0);
  }

  function insertBreak(): void {
    const selection = win.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const br = doc.createElement('br');
    range.insertNode(br);
    // a break at the very end shows only with a second one after it; serialize drops trailing breaks
    if (!br.nextSibling) br.parentNode?.appendChild(doc.createElement('br'));
    const after = doc.createRange();
    after.setStartAfter(br);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
  }

  function finish(current: Session): void {
    current.done = true;
    const element = current.element;
    element.removeEventListener('keydown', onKey);
    element.removeEventListener('beforeinput', onBeforeInput);
    element.removeEventListener('paste', onPaste);
    element.removeEventListener('drop', onDrop);
    element.removeEventListener('focusout', onFocusOut);
    element.removeEventListener('input', onInput);
    element.removeAttribute('contenteditable');
    element.removeAttribute('role');
    element.removeAttribute('aria-label');
    element.classList.remove('ff-editing');
    current.badge?.remove();
    if (session === current) session = null;
  }

  function commit(): void {
    const current = session;
    if (!current || current.done) return;
    const items = serialize(current.element);
    finish(current);
    say({ type: 'formfeed:edit-commit', token: current.token, items });
  }

  function cancel(tell: boolean): void {
    const current = session;
    if (!current || current.done) return;
    const element = current.element;
    while (element.firstChild) element.removeChild(element.firstChild);
    for (const node of current.saved) element.appendChild(node);
    finish(current);
    if (tell) say({ type: 'formfeed:edit-cancel', token: current.token });
  }
}

/** The element's content as items: text, chips by index, breaks; anything the browser added is flattened. */
export function serialize(element: Element): FrameEditItem[] {
  const items: FrameEditItem[] = [];
  const text = (value: string) => {
    const last = items[items.length - 1];
    if (last?.kind === 'text') last.text += value;
    else if (value) items.push({ kind: 'text', text: value });
  };
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) text((child as Text).data);
      else if (child.nodeType === 1) {
        const element = child as Element;
        const chip = element.getAttribute('data-ff-chip');
        if (chip !== null) items.push({ kind: 'chip', index: Number(chip) });
        else if (element.tagName === 'BR') items.push({ kind: 'break' });
        else if (element.tagName === 'DIV' || element.tagName === 'P') {
          // a block a browser inserted for Enter: a line of its own
          if (items.length) items.push({ kind: 'break' });
          walk(element);
        } else walk(element);
      }
    }
  };
  walk(element);
  while (items[items.length - 1]?.kind === 'break') items.pop();
  return items;
}
