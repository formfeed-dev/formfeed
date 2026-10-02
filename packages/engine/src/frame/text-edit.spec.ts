// @vitest-environment jsdom
import { installTextEdit, serialize, type EditBegin } from './text-edit';

describe('the preview edit session', () => {
  let sent: Array<Record<string, unknown>>;
  let inspected: number;

  beforeAll(() => installTextEdit(window));

  beforeEach(() => {
    sent = [];
    inspected = 0;
    vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      sent.push(message as Record<string, unknown>);
    });
    document.body.innerHTML = `
      <h1 data-ff-src="body:1:1" data-ff-edit="text">Dear <b>Erika</b>, thanks</h1>
      <p data-ff-src="body:2:1">Not editable</p>
      <span data-ff-src="body:3:1" data-ff-edit="text">a</span><span data-ff-src="body:3:1" data-ff-edit="text">b</span>`;
  });
  afterEach(() => vi.restoreAllMocks());

  // the click-to-source listener registers after the session's, as in the preview document
  const onInspect = () => inspected++;
  beforeAll(() => document.addEventListener('click', onInspect, true));
  afterAll(() => document.removeEventListener('click', onInspect, true));

  const fromEditor = (data: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data, source: window }));
  const h1 = () => document.querySelector('h1') as HTMLElement;
  const begin = (overrides: Partial<EditBegin> = {}) =>
    fromEditor({
      type: 'formfeed:edit-begin',
      token: 't1',
      src: 'body:1:1',
      allowBreaks: true,
      items: [
        { kind: 'text', text: 'Dear ' },
        { kind: 'chip', index: 0, text: 'Erika', title: 'customer.name' },
        { kind: 'text', text: ', thanks' },
      ],
      ...overrides,
    });

  it('marks the document as being in edit mode', () => {
    expect(document.documentElement.classList.contains('ff-edit-mode')).toBe(
      true,
    );
    expect(
      document.querySelector('style[data-formfeed="edit"]'),
    ).not.toBeNull();
  });

  it('asks the editor about an editable element instead of revealing its source', () => {
    h1()
      .querySelector('b')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'formfeed:edit-request',
        src: 'body:1:1',
        edit: 'text',
        text: 'Dear Erika, thanks',
        count: 1,
        split: false,
      }),
    ]);
    expect(inspected).toBe(0);
    document
      .querySelector('span[data-ff-src]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent[1]).toMatchObject({ count: 2 });
  });

  it('leaves clicks on other elements to click-to-source', () => {
    document
      .querySelector('p')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent).toEqual([]);
    expect(inspected).toBe(1);
  });

  it('shows the items with atomic chips and sends the edit on Enter', () => {
    h1().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    begin({ note: 'Changes all 2', label: 'Edit text' });
    const element = h1();
    expect(element.contentEditable).toBe('true');
    expect(element.getAttribute('aria-label')).toBe('Edit text');
    const chip = element.querySelector('[data-ff-chip]') as HTMLElement;
    expect(chip.getAttribute('contenteditable')).toBe('false');
    expect(chip.title).toBe('customer.name');
    expect(document.querySelector('.ff-edit-badge')?.textContent).toBe(
      'Changes all 2',
    );

    (element.lastChild as Text).data = ', many thanks';
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(sent.at(-1)).toEqual({
      type: 'formfeed:edit-commit',
      token: 't1',
      items: [
        { kind: 'text', text: 'Dear ' },
        { kind: 'chip', index: 0 },
        { kind: 'text', text: ', many thanks' },
      ],
    });
    expect(element.hasAttribute('contenteditable')).toBe(false);
    expect(document.querySelector('.ff-edit-badge')).toBeNull();
  });

  it('puts the element back as it was on Escape', () => {
    h1().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    begin();
    h1().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(h1().innerHTML).toBe('Dear <b>Erika</b>, thanks');
    expect(sent.at(-1)).toEqual({ type: 'formfeed:edit-cancel', token: 't1' });
  });

  it('confirms a session that started and answers one that cannot, so the editor never waits for it', () => {
    h1().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    begin();
    expect(sent.at(-1)).toEqual({ type: 'formfeed:edit-started', token: 't1' });
    h1().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    // an element this document does not have: a layer added after it was rendered
    begin({ token: 't2', src: 'body:9:1' });
    expect(sent.at(-1)).toEqual({ type: 'formfeed:edit-cancel', token: 't2' });
    begin({ token: 't3', src: '', layer: 'missing' });
    expect(sent.at(-1)).toEqual({ type: 'formfeed:edit-cancel', token: 't3' });
  });

  it('opens no session in a window the user has left for the app, and opens one again once back', () => {
    // asked for with the focus here; then a press in the app got ahead of the editor's answer
    h1().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    try {
      begin({ token: 't4' });
      // focusing the element now would take the focus out of the field the user went to
      expect(sent.at(-1)).toEqual({
        type: 'formfeed:edit-cancel',
        token: 't4',
      });
      // the property: jsdom does not reflect it into the attribute
      expect(h1().contentEditable).not.toBe('true');
      expect(h1().innerHTML).toBe('Dear <b>Erika</b>, thanks');
    } finally {
      window.dispatchEvent(new Event('focus'));
      hasFocus.mockRestore();
    }
    begin({ token: 't5' });
    expect(sent.at(-1)).toEqual({ type: 'formfeed:edit-started', token: 't5' });
    expect(h1().contentEditable).toBe('true');
  });

  it('opens a session in a window never seen to lose the focus, whatever the document reports', () => {
    // only a window that was left counts, so a browser that reports the focus differently still types
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    begin({ token: 't6' });
    expect(sent.at(-1)).toEqual({ type: 'formfeed:edit-started', token: 't6' });
  });

  it('commits when focus leaves the frame for the editor, although its active element stays', async () => {
    h1().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    begin();
    (h1().lastChild as Text).data = ', see you';
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    h1().dispatchEvent(new FocusEvent('focusout'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.at(-1)).toMatchObject({
      type: 'formfeed:edit-commit',
      token: 't1',
    });
    expect(h1().hasAttribute('contenteditable')).toBe(false);
    hasFocus.mockRestore();
  });

  it('ignores messages that do not come from the editor', () => {
    h1().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'formfeed:edit-begin',
          token: 'x',
          src: 'body:1:1',
          items: [],
        },
        source: null,
      }),
    );
    expect(h1().hasAttribute('contenteditable')).toBe(false);
  });

  it("forwards undo and redo outside a session, the frame's keys never reaching the editor", () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Z',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'y',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(sent.map((m) => m['type'])).toEqual([
      'formfeed:undo',
      'formfeed:redo',
      'formfeed:redo',
    ]);
  });

  it('flattens what a browser adds and drops trailing breaks', () => {
    const element = document.createElement('div');
    element.innerHTML =
      'a<span style="color:red">b</span><span data-ff-chip="1">x</span>c<br><div>d<font>e</font></div><br><br>';
    expect(serialize(element)).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'chip', index: 1 },
      { kind: 'text', text: 'c' },
      { kind: 'break' },
      { kind: 'break' },
      { kind: 'text', text: 'de' },
    ]);
  });
});
