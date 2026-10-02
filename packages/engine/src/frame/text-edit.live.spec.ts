// @vitest-environment jsdom
import { installTextEdit } from './text-edit';

// The design stage's sessions (a file of its own: the preview's spec installs the runtime without `live`)
describe('the design stage edit session', () => {
  let sent: Array<Record<string, unknown>>;

  beforeAll(() => installTextEdit(window, { clicks: false, live: true }));

  beforeEach(() => {
    sent = [];
    vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      sent.push(message as Record<string, unknown>);
    });
    document.body.innerHTML =
      '<div data-ff-layer="title"><p class="ff-text">Hello</p></div>';
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports what was typed on every change, so a frame that goes away loses nothing', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'formfeed:edit-begin',
          token: 'k1',
          src: '',
          layer: 'title',
          allowBreaks: true,
          items: [{ kind: 'text', text: 'Hello' }],
        },
        source: window,
      }),
    );
    const text = document.querySelector('.ff-text') as HTMLElement;
    expect(text.contentEditable).toBe('true');
    (text.firstChild as Text).data = 'Hello there';
    text.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(sent.at(-1)).toEqual({
      type: 'formfeed:edit-input',
      token: 'k1',
      items: [{ kind: 'text', text: 'Hello there' }],
    });
    // a click on the stage never asks the editor: the stage starts sessions itself
    text.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    const count = sent.length;
    text.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent).toHaveLength(count);
    // after the session no change is reported
    text.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(sent).toHaveLength(count);
  });

  it('starts with the key that was typed on the canvas, after what is there', () => {
    // selecting a text and typing starts the session: the stage hands over the first character,
    // and a point for the caret, which jsdom cannot resolve, so the caret goes to the end
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'formfeed:edit-begin',
          token: 'k2',
          src: '',
          layer: 'title',
          allowBreaks: true,
          at: { x: 10, y: 10 },
          insert: '!',
          items: [{ kind: 'text', text: 'Hello' }],
        },
        source: window,
      }),
    );
    const text = document.querySelector('.ff-text') as HTMLElement;
    expect(text.textContent).toBe('Hello!');
    // the session is confirmed first, then the typed character is reported like any other change
    expect(sent.map((message) => message['type'])).toEqual([
      'formfeed:edit-started',
      'formfeed:edit-input',
    ]);
    expect(sent.at(-1)).toMatchObject({
      token: 'k2',
      items: [{ kind: 'text', text: 'Hello!' }],
    });
  });

  it('passes Ctrl+B, Ctrl+I and Ctrl+U on to the canvas, which styles the whole layer', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'formfeed:edit-begin',
          token: 'k4',
          src: '',
          layer: 'title',
          allowBreaks: true,
          items: [{ kind: 'text', text: 'Hello' }],
        },
        source: window,
      }),
    );
    const text = document.querySelector('.ff-text') as HTMLElement;
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      text.dispatchEvent(event);
      return event;
    };
    // the browser's own bold would put markup into a text that is one style throughout
    expect(press({ key: 'b', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: 'formfeed:edit-style',
      token: 'k4',
      key: 'b',
    });
    press({ key: 'U', metaKey: true });
    expect(sent.at(-1)).toMatchObject({
      type: 'formfeed:edit-style',
      key: 'u',
    });
    // AltGr reports Ctrl and Alt on Windows: that is a character, not a style
    const count = sent.length;
    press({ key: 'i', ctrlKey: true, altKey: true });
    press({ key: 'b' });
    expect(sent).toHaveLength(count);
    // the session goes on
    expect(text.contentEditable).toBe('true');
  });

  it('starts with the whole text selected for a text added a moment ago', () => {
    // a new text holds a placeholder: what is typed first replaces it
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'formfeed:edit-begin',
          token: 'k3',
          src: '',
          layer: 'title',
          allowBreaks: true,
          select: 'all',
          items: [{ kind: 'text', text: 'Hello' }],
        },
        source: window,
      }),
    );
    const text = document.querySelector('.ff-text') as HTMLElement;
    const selection = window.getSelection()!;
    expect(selection.isCollapsed).toBe(false);
    expect(selection.toString()).toBe('Hello');
    expect(text.contains(selection.anchorNode)).toBe(true);
    // a paste goes where the selection is, so it replaces the placeholder
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(paste, {
      clipboardData: { getData: () => 'Winter sale' },
    });
    text.dispatchEvent(paste);
    expect(text.textContent).toBe('Winter sale');
    expect(sent.at(-1)).toMatchObject({
      type: 'formfeed:edit-input',
      token: 'k3',
      items: [{ kind: 'text', text: 'Winter sale' }],
    });
  });

  describe('a click that lands on a chip', () => {
    // jsdom lays nothing out: the browser's answer to "which caret is at this point" is given here,
    // inside the chip's text, as Chromium answers for a click on a field's value
    const withCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    beforeEach(() => {
      withCaret.caretRangeFromPoint = () => {
        const chip = document.querySelector('[data-ff-chip]')!;
        const range = document.createRange();
        range.setStart(chip.firstChild!, 2);
        return range;
      };
      // every box spans 100 to 200 px: the chip's middle is at 150
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        width: 100,
      } as DOMRect);
    });
    afterEach(() => delete withCaret.caretRangeFromPoint);

    const begin = (x: number) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'formfeed:edit-begin',
            token: 'k5',
            src: '',
            layer: 'title',
            allowBreaks: true,
            at: { x, y: 10 },
            items: [
              { kind: 'text', text: 'By ' },
              { kind: 'chip', index: 0, text: 'Max Mustermann' },
            ],
          },
          source: window,
        }),
      );
    const paste = (value: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.assign(event, { clipboardData: { getData: () => value } });
      document.querySelector('.ff-text')!.dispatchEvent(event);
    };

    it('puts the caret after the chip for a point in its right half: a caret inside a chip types nothing', () => {
      begin(180);
      const text = document.querySelector('.ff-text') as HTMLElement;
      const selection = window.getSelection()!;
      // not in the chip's text, where no key would arrive: in the element, after the chip
      expect(selection.anchorNode).toBe(text);
      expect(selection.anchorOffset).toBe(2);
      paste(' · 4 min read');
      expect(sent.at(-1)).toMatchObject({
        type: 'formfeed:edit-input',
        items: [
          { kind: 'text', text: 'By ' },
          { kind: 'chip', index: 0 },
          { kind: 'text', text: ' · 4 min read' },
        ],
      });
    });

    it('puts the caret before the chip for a point in its left half', () => {
      begin(120);
      const text = document.querySelector('.ff-text') as HTMLElement;
      const selection = window.getSelection()!;
      expect(selection.anchorNode).toBe(text);
      expect(selection.anchorOffset).toBe(1);
      paste('editor ');
      expect(sent.at(-1)).toMatchObject({
        type: 'formfeed:edit-input',
        items: [
          { kind: 'text', text: 'By editor ' },
          { kind: 'chip', index: 0 },
        ],
      });
    });
  });
});
