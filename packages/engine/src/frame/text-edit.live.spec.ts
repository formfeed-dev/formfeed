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
});
