import { installTextEdit } from './text-edit';

/**
 * The runtime of the design stage's frame (plan 16 §4.6). The frame shows the emitted template and
 * takes no pointer events: the editor draws selection and handles in an overlay and talks to the
 * frame by message. Bundled by `engine:frames`; keep it self-contained.
 *
 * - `formfeed:ready` (frame → editor), once the fonts are loaded and text is fitted, and again after
 *   every stylesheet patch: each layer's laid-out size and whether its text overflows its box.
 * - `formfeed:layer-style` (editor → frame): position, size and rotation of one layer during a drag,
 *   applied inline; `formfeed:layer-style-clear` drops them.
 * - `formfeed:css`: the template's stylesheet replaced in place, without a reload.
 * - The edit session of `text-edit.ts`, addressed by layer, for typing in place.
 */
export interface StageLayerBox {
  id: string;
  width: number;
  height: number;
  overflow: boolean;
}

export function measureLayers(doc: Document, win: Window): StageLayerBox[] {
  return Array.from(doc.querySelectorAll<HTMLElement>('[data-ff-layer]')).map(
    (element) => {
      const text = element.querySelector<HTMLElement>(':scope > .ff-text');
      let overflow = false;
      if (text && element.style.height !== 'auto') {
        const style = win.getComputedStyle(element);
        const available =
          element.clientHeight -
          (parseFloat(style.paddingTop) || 0) -
          (parseFloat(style.paddingBottom) || 0);
        // a box that grows with its text has no height of its own to overflow
        overflow =
          style.overflow === 'hidden' &&
          (text.scrollHeight > available + 1 ||
            text.scrollWidth > text.clientWidth + 1);
      }
      return {
        id: element.getAttribute('data-ff-layer') ?? '',
        width: element.offsetWidth,
        height: element.offsetHeight,
        overflow,
      };
    },
  );
}

export function installStage(win: Window & { formfeedFit?: () => void }): void {
  const doc = win.document;
  const say = (message: Record<string, unknown>) => {
    try {
      win.parent.postMessage(message, '*');
    } catch {
      // the editor is gone
    }
  };
  const layerElement = (id: unknown) =>
    typeof id === 'string'
      ? doc.querySelector<HTMLElement>(
          `[data-ff-layer="${id.replace(/"/g, '')}"]`,
        )
      : null;
  const clearInline = () => {
    for (const element of Array.from(
      doc.querySelectorAll<HTMLElement>('[data-ff-layer]'),
    ))
      for (const name of ['left', 'top', 'width', 'height', 'transform'])
        element.style.removeProperty(name);
  };
  const report = () => {
    win.formfeedFit?.();
    say({ type: 'formfeed:ready', layers: measureLayers(doc, win) });
  };

  win.addEventListener('message', (event) => {
    if (event.source !== win.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data['type'] !== 'string') return;
    if (data['type'] === 'formfeed:layer-style') {
      const element = layerElement(data['id']);
      if (!element) return;
      const set = (name: string, value: unknown) => {
        if (typeof value === 'number' && Number.isFinite(value))
          element.style.setProperty(name, `${value}px`);
      };
      set('left', data['left']);
      set('top', data['top']);
      set('width', data['width']);
      set('height', data['height']);
      if (
        typeof data['rotation'] === 'number' &&
        Number.isFinite(data['rotation'])
      )
        element.style.setProperty(
          'transform',
          data['rotation'] ? `rotate(${data['rotation']}deg)` : 'none',
        );
    } else if (data['type'] === 'formfeed:layer-style-clear') clearInline();
    else if (
      data['type'] === 'formfeed:css' &&
      typeof data['css'] === 'string'
    ) {
      const sheet = doc.querySelector('style[data-formfeed="template"]');
      if (sheet) sheet.textContent = data['css'];
      clearInline();
      report();
    }
  });

  installTextEdit(win, { clicks: false, live: true });

  const fonts = (doc as Document & { fonts?: { ready: Promise<unknown> } })
    .fonts;
  const start = () => (fonts ? void fonts.ready.then(report) : report());
  if (doc.readyState === 'complete') start();
  else win.addEventListener('load', start);
}
