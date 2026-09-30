/**
 * Fit text to its box (plan 16 §4.3): an element with `data-ff-fit="shrink"` and a fixed size gets
 * the largest font size between its own CSS size and `data-ff-fit-min` (px) at which its text fits.
 * `assembleDocument` adds this script when a document contains the attribute. It runs once the fonts
 * are loaded and again whenever `window.formfeedFit()` is called: the paged preview after Paged.js,
 * the design stage after a stylesheet change, the render-worker before it captures. Every run starts
 * from the CSS size, so it is idempotent. Bundled by `engine:frames`; keep it self-contained.
 */
export function fits(
  box: HTMLElement,
  text: HTMLElement,
  win: Window,
): boolean {
  if (text === box)
    return (
      box.scrollHeight <= box.clientHeight + 0.5 &&
      box.scrollWidth <= box.clientWidth + 0.5
    );
  const style = win.getComputedStyle(box);
  const available =
    box.clientHeight -
    (parseFloat(style.paddingTop) || 0) -
    (parseFloat(style.paddingBottom) || 0);
  return (
    text.scrollHeight <= available + 0.5 &&
    text.scrollWidth <= text.clientWidth + 0.5
  );
}

export function fitBox(box: HTMLElement, win: Window): number {
  const text = (box.firstElementChild as HTMLElement | null) ?? box;
  text.style.fontSize = '';
  const max = parseFloat(win.getComputedStyle(text).fontSize) || 16;
  const min = Math.min(
    max,
    parseFloat(box.getAttribute('data-ff-fit-min') ?? '') || max / 2,
  );
  if (fits(box, text, win)) return max;
  let low = min;
  let high = max;
  for (let i = 0; i < 14; i++) {
    const middle = (low + high) / 2;
    text.style.fontSize = `${middle}px`;
    if (fits(box, text, win)) low = middle;
    else high = middle;
  }
  const size = Math.floor(low * 100) / 100;
  text.style.fontSize = `${size}px`;
  return size;
}

export function installFit(win: Window & { formfeedFit?: () => void }): void {
  const run = () => {
    for (const box of Array.from(
      win.document.querySelectorAll<HTMLElement>('[data-ff-fit="shrink"]'),
    ))
      fitBox(box, win);
    win.document.documentElement.setAttribute('data-ff-fit', 'done');
  };
  win.formfeedFit = run;
  const fonts = (
    win.document as Document & { fonts?: { ready: Promise<unknown> } }
  ).fonts;
  if (fonts) void fonts.ready.then(run);
  else win.addEventListener('load', run);
}
