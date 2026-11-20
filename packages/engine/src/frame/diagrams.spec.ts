// @vitest-environment jsdom
import {
  DEFAULT_ACCENT,
  cssColour,
  drawDiagrams,
  errorLine,
  mermaidConfig,
  messageOf,
  readDiagram,
  tint,
  type MermaidApi,
} from './diagrams';

/**
 * The runner that draws a Markdown document's diagrams (plan 33, decision 10), with a stand-in for
 * Mermaid: jsdom lays nothing out, so what Mermaid draws is held by the render-worker's specs with
 * real Chromium; here, what the runner does with what it is given.
 */
const page = (body: string) => {
  document.body.innerHTML = body;
};
/** A figure as the converter writes it (`rich/diagrams.ts`), the line break after `<pre>` included. */
const figure = (line: number, source: string) =>
  `<figure class="ff-diagram" role="img"><pre data-ff-mermaid data-ff-line="${line}">\n${source}</pre></figure>`;

/** A stand-in that draws an SVG with the title and description it is told, or throws. */
function stand(answers: Record<string, string | Error>): MermaidApi & {
  configs: unknown[];
  drawn: string[];
} {
  const configs: unknown[] = [];
  const drawn: string[] = [];
  return {
    configs,
    drawn,
    initialize: (config) => configs.push(config),
    render: async (id, text) => {
      drawn.push(`${id}:${text}`);
      const answer = answers[text] ?? '';
      if (answer instanceof Error) throw answer;
      return {
        svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg">${answer}<g></g></svg>`,
      };
    },
  };
}

describe('drawing the diagrams', () => {
  it('replaces each source with its picture, in order, and names its figure from the source’s accTitle and accDescr', async () => {
    page(
      '<div class="ff-markdown">' +
        figure(
          4,
          'flowchart LR\n  accTitle: Order flow\n  accDescr: An order is checked.\n  A --> B',
        ) +
        figure(
          10,
          'pie\n  accTitle: Revenue by region.\n  accDescr: North first',
        ) +
        figure(15, 'sequenceDiagram') +
        '</div>',
    );
    // a picture that names itself, as Mermaid's C4 diagram does with the title of the one before
    const stale = '<title>Order flow</title><desc>An order is checked.</desc>';
    const mermaid = stand({
      'flowchart LR\n  A --> B': stale,
      pie: stale,
      sequenceDiagram: stale,
    });
    expect(await drawDiagrams(window, mermaid)).toEqual({ drawn: 3 });
    // Mermaid gets the sources without the two lines
    expect(mermaid.drawn).toEqual([
      'ff-diagram-1:flowchart LR\n  A --> B',
      'ff-diagram-2:pie',
      'ff-diagram-3:sequenceDiagram',
    ]);
    const figures = Array.from(document.querySelectorAll('figure'));
    expect(figures.map((f) => f.getAttribute('aria-label'))).toEqual([
      'Order flow. An order is checked.',
      'Revenue by region. North first',
      // without accTitle the figure has no name, whatever the picture says, which the template
      // check and veraPDF report
      null,
    ]);
    expect(document.querySelectorAll('pre[data-ff-mermaid]')).toHaveLength(0);
    expect(
      figures.every(
        (f) => f.firstElementChild?.tagName.toLowerCase() === 'svg',
      ),
    ).toBe(true);
  });

  it('reads the source as text, which the converter escaped', async () => {
    page(figure(3, 'A[&quot;x &lt; y&quot;] --&gt; B'));
    const mermaid = stand({});
    await drawDiagrams(window, mermaid);
    expect(mermaid.drawn).toEqual(['ff-diagram-1:A["x < y"] --> B']);
  });

  it('answers with the first diagram that fails, by the line of the document, and draws no more', async () => {
    const jison = Object.assign(
      new Error(
        "Parse error on line 3:\n...A --> B -->\n-----------^\nExpecting 'AMP', 'COLON', got 'EOF'",
      ),
      { hash: { loc: { first_line: 3 } } },
    );
    const broken = 'flowchart LR\n  A --> B\n  B -->';
    page(figure(4, 'ok') + figure(12, broken) + figure(20, 'never'));
    const mermaid = stand({ [broken]: jison });
    expect(await drawDiagrams(window, mermaid)).toEqual({
      failed: { line: 14, message: "Expecting 'AMP', 'COLON', got 'EOF'" },
    });
    expect(mermaid.drawn).toEqual([
      'ff-diagram-1:ok',
      `ff-diagram-2:${broken}`,
    ]);
  });

  it('counts the lines it took out before the diagram’s first line into an error’s line', async () => {
    const jison = Object.assign(new Error('Parse error on line 2:'), {
      hash: { loc: { first_line: 2 }, token: 'EOF' },
    });
    // the fence's first line of source is 6: a comment and an empty line, then the diagram
    page(figure(6, '%% the flow\n\nflowchart LR\n  A -->'));
    const mermaid = stand({ 'flowchart LR\n  A -->': jison });
    expect(await drawDiagrams(window, mermaid)).toEqual({
      failed: { line: 9, message: 'Parse error' },
    });
  });

  it('says so without Mermaid, and does nothing without diagrams', async () => {
    page(figure(2, 'pie'));
    expect(await drawDiagrams(window, undefined)).toEqual({
      unavailable: 'Mermaid did not load',
    });
    page('<p>No diagrams.</p>');
    expect(await drawDiagrams(window, undefined)).toEqual({ drawn: 0 });
  });

  it('configures Mermaid strictly, and in the document’s font and accent', async () => {
    page(
      `<div class="ff-markdown" style="font-family: Georgia; --brand-color-primary: #0a7a5c">${figure(2, 'pie')}</div>`,
    );
    const mermaid = stand({});
    await drawDiagrams(window, mermaid);
    expect(mermaid.configs[0]).toMatchObject({
      securityLevel: 'strict',
      deterministicIds: true,
      theme: 'base',
      fontFamily: 'Georgia',
      themeVariables: {
        primaryBorderColor: '#0a7a5c',
        primaryColor: tint('#0a7a5c', 0.86),
        dropShadow: 'none',
      },
    });
  });
});

describe('its parts', () => {
  it('keeps what a diagram’s own directive must not change', () => {
    const config = mermaidConfig({
      fontFamily: 'Noto Sans',
      accent: DEFAULT_ACCENT,
    });
    expect(config['secure']).toEqual(
      expect.arrayContaining([
        'securityLevel',
        'deterministicIds',
        'maxTextSize',
        'startOnLoad',
      ]),
    );
    expect(config).toMatchObject({
      startOnLoad: false,
      suppressErrorRendering: true,
      maxTextSize: 51_200,
    });
  });

  it('names the line from Jison’s location, from the message, or the diagram’s first line', () => {
    expect(
      errorLine(10, { hash: { loc: { first_line: 2 }, token: 'EOF' } }),
    ).toBe(11);
    expect(
      errorLine(10, new Error('Lexer error on line 3, column 11: unexpected')),
    ).toBe(12);
    expect(errorLine(10, new Error('No diagram type detected'))).toBe(10);
    // through the map of the lines Mermaid counts, its last line past its end
    const lines = [4, 6];
    const at = (n: number) => ({
      hash: { loc: { first_line: n }, token: 'X' },
    });
    expect(errorLine(10, at(2), lines)).toBe(16);
    expect(errorLine(10, at(9), lines)).toBe(16);
    expect(errorLine(10, new Error('No diagram type detected'), lines)).toBe(
      14,
    );
    // a flowchart's error about a node, which counts three lines of front matter in itself
    const node = { hash: { loc: { first_line: 5 }, token: null } };
    expect(errorLine(10, node, undefined, 3)).toBe(11);
    expect(errorLine(10, at(5), undefined, 3)).toBe(14);
  });

  it('keeps a message to one line without the excerpt and the caret', () => {
    expect(
      messageOf(
        new Error(
          "Parse error on line 2:\nA -->\n----^\nExpecting 'NODE', got 'EOF'",
        ),
      ),
    ).toBe("Expecting 'NODE', got 'EOF'");
    expect(messageOf(new Error('No diagram type\n detected'))).toBe(
      'No diagram type detected',
    );
    expect(messageOf(new Error('x'.repeat(400)))).toHaveLength(300);
    // Langium's, as Mermaid 12's pie parser writes it, without positions of its own
    expect(
      messageOf(
        new Error(
          "Parsing failed: Lexer error on line 2, column 9: unexpected character: ->x<- at offset: 12, skipped 1 characters. Parse error on line 2, column 10: Expecting token of type 'NUMBER_PIE' but found `\n`.",
        ),
      ),
    ).toBe(
      "Lexer error: unexpected character: ->x<-, skipped 1 characters. Parse error: Expecting token of type 'NUMBER_PIE' but found the end of a line.",
    );
  });

  it('names a diagram by its accTitle and accDescr, joined by one full stop', () => {
    const name = (source: string) => readDiagram(source).name;
    expect(
      name('flowchart LR\n  accTitle:  A  flow \n  accDescr: Two steps'),
    ).toBe('A flow. Two steps');
    expect(name('pie\n  accTitle: Done?\n  accDescr: Yes')).toBe('Done? Yes');
    expect(name('pie\n  accDescr: Only a description')).toBe(
      'Only a description',
    );
    // the text ends before an inline comment, and the last of each line counts, as in Mermaid
    expect(name('pie\naccTitle: First\naccTitle: Second %% not the name')).toBe(
      'Second',
    );
    expect(name('flowchart LR\n  A --> B')).toBe('');
  });

  it('takes the two lines out of what Mermaid reads and maps the rest to the source’s lines', () => {
    const read = readDiagram(
      'mindmap\n  accTitle: Plan\n  root((Plan))\n    accDescr: Code and math\n    Code',
    );
    // no empty line after `mindmap`, which Mermaid refuses there; further down one is fine
    expect(read.text).toBe('mindmap\n  root((Plan))\n\n    Code');
    expect(read).toMatchObject({
      name: 'Plan. Code and math',
      lines: [0, 2, 3, 4],
    });
  });

  it('reads accDescr over several lines up to its first closing brace', () => {
    const read = readDiagram(
      'flowchart LR\n  accDescr {\n    An order\n    %% not said\n    is checked\n  } A --> B\n  C --> D',
    );
    expect(read.name).toBe('An order is checked');
    expect(read.text).toBe('flowchart LR\n A --> B\n  C --> D');
    expect(read.lines).toEqual([0, 5, 6]);
    expect(readDiagram('pie\naccDescr { on one line }\n"A" : 1')).toMatchObject(
      { name: 'on one line', text: 'pie\n"A" : 1', lines: [0, 2] },
    );
    // never closed: Mermaid's to refuse, with its own line
    const open = 'pie\naccDescr {\n"A" : 1';
    expect(readDiagram(open)).toMatchObject({
      name: '',
      text: open,
      lines: [0, 1, 2],
    });
  });

  it('takes comments out, and puts leading directives onto the first line', () => {
    const read = readDiagram(
      '\n%% a note\n%%{init: {"theme": "forest"}}%%\n\nflowchart LR\n  %% another\n  A --> B',
    );
    expect(read.text).toBe(
      '%%{init: {"theme": "forest"}}%%flowchart LR\n  A --> B',
    );
    expect(read).toMatchObject({ lines: [4, 6], front: 0 });
    // a directive over several lines becomes one
    expect(
      readDiagram('%%{init: {\n  "theme": "forest"\n}}%%\npie\n"A" : 1'),
    ).toMatchObject({
      text: '%%{init: { "theme": "forest" }}%%pie\n"A" : 1',
      lines: [3, 4],
    });
    // further down, a comment's line stays as an empty line, so the lines after it keep theirs
    expect(readDiagram('pie\n"A" : 1\n%% note\n"B" : 2')).toMatchObject({
      text: 'pie\n"A" : 1\n\n"B" : 2',
      lines: [0, 1, 2, 3],
    });
  });

  it('keeps front matter as written, and maps from the line after it', () => {
    const read = readDiagram(
      '---\ntitle: Flow\naccTitle: not ours\n---\n\nflowchart LR\n  A --> B',
    );
    expect(read.text).toBe(
      '---\ntitle: Flow\naccTitle: not ours\n---\nflowchart LR\n  A --> B',
    );
    expect(read).toMatchObject({ name: '', lines: [5, 6], front: 4 });
    // without its closing line, it is no front matter
    expect(readDiagram('---\npie\n"A" : 1')).toMatchObject({
      lines: [0, 1, 2],
      front: 0,
    });
    // nothing to draw: the source as written, for Mermaid to say so
    expect(readDiagram('\n  \n')).toEqual({
      text: '\n  \n',
      name: '',
      lines: [0],
      front: 0,
    });
  });

  it('reads a colour as the page computes it, and nothing that is no colour', () => {
    expect(cssColour(window, '#0a7a5c')).toBe('#0a7a5c');
    expect(cssColour(window, 'rgb(1, 2, 3)')).toBe('#010203');
    expect(cssColour(window, 'not a colour')).toBeNull();
    expect(cssColour(window, '')).toBeNull();
    expect(tint('#000000', 0.5)).toBe('#808080');
  });
});
