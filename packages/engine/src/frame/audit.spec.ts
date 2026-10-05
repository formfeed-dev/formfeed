// @vitest-environment jsdom
import { audit, generatedText, rowWidths, startTag } from './audit';

/**
 * The audit's findings on small documents. jsdom lays nothing out, so what depends on a browser's
 * layout and painting (pseudo-elements, the real page count, Chromium's own tagging) is held by the
 * render-worker's corpus, which runs this script in the page it prints.
 */
const page = (body: string, head = '<title>Rechnung</title>', lang = 'de') => {
  document.documentElement.setAttribute('lang', lang);
  if (!lang) document.documentElement.removeAttribute('lang');
  document.head.innerHTML = head;
  document.body.innerHTML = body;
};
const codes = (options = {}) =>
  audit(window, options).findings.map((finding) => finding.code);
const px =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4z8BAEmIY1TCqYfhqAAAkPf4Cz1oNmQAAAABJRU5ErkJggg==';

describe('the audit', () => {
  it('finds nothing in a document that is in order', () => {
    page(
      `<h1>Rechnung</h1><h2>Positionen</h2><img src="${px}" alt="Logo">` +
        '<table><tr><th>Leistung</th><th>Summe</th></tr><tr><td>Beratung</td><td>960 €</td></tr></table>' +
        '<p><a href="https://formfeed.test/agb">Unsere Bedingungen</a></p>',
    );
    expect(audit(window).findings).toEqual([]);
  });

  describe('the document', () => {
    it('asks for a title, and never takes anything else for one', () => {
      page('<h1>Rechnung</h1>', '');
      expect(codes()).toEqual(['document-title']);
      page('<h1>Rechnung</h1>', '<title>   </title>');
      expect(codes()).toEqual(['document-title']);
    });

    it('asks for a language where neither the document nor the settings name one', () => {
      page('<h1>Rechnung</h1>', '<title>Rechnung</title>', '');
      expect(codes()).toEqual(['document-language']);
      expect(codes({ locale: true })).toEqual([]);
    });
  });

  describe('images and figures', () => {
    it('reports an image without alt, at its tag', () => {
      page(
        `<h1>A</h1><p><img src="${px}" class="logo" data-ff-src="body:3:1"></p>`,
      );
      const [finding] = audit(window).findings;
      expect(finding).toMatchObject({
        code: 'image-alt',
        severity: 'error',
        src: 'body:3:1',
      });
      // the snippet is the author's tag: no editor attribute, and no embedded image in full
      expect(finding!.snippet).toBe(
        '<img src="data:image/png;base64,iVBORw0KGgoAAAANSU…" class="logo">',
      );
    });

    it('takes an empty alt for the decision it is, and knows the other ways to name or hide an image', () => {
      page(
        `<h1>A</h1><img src="${px}" alt=""><img src="${px}" aria-label="Logo"><img src="${px}" title="Logo">` +
          `<img src="${px}" role="presentation"><img src="${px}" aria-hidden="true">` +
          `<span aria-hidden="true"><img src="${px}"></span><img src="${px}" style="display:none">` +
          `<div hidden><img src="${px}"></div>`,
      );
      expect(codes()).toEqual([]);
    });

    it('reports a canvas and a role="img" without a name', () => {
      page(
        '<h1>A</h1><canvas id="a"></canvas><canvas aria-label="Umsatz nach Quartal"></canvas>' +
          '<svg role="img"><rect/></svg><svg role="img"><title>Logo</title></svg><svg><rect/></svg>' +
          '<div role="img"></div><span id="n">Diagramm</span><div role="img" aria-labelledby="n"></div>',
      );
      const figures = audit(window).findings;
      expect(figures.map((f) => [f.code, f.args['tag']])).toEqual([
        ['figure-name', 'canvas'],
        ['figure-name', 'svg'],
        ['figure-name', 'div'],
      ]);
    });
  });

  describe('headings', () => {
    it('wants an h1 first', () => {
      page('<h2>Positionen</h2><h3>Details</h3>');
      expect(audit(window).findings).toMatchObject([
        { code: 'heading-order', args: { level: 2, previous: 0 } },
      ]);
    });

    it('reports a level skipped on the way down, and none on the way up', () => {
      page('<h1>A</h1><h3>B</h3><h4>C</h4><h2>D</h2><h5>E</h5>');
      expect(audit(window).findings).toMatchObject([
        {
          code: 'heading-order',
          args: { level: 3, previous: 1 },
          snippet: '<h3>',
        },
        {
          code: 'heading-order',
          args: { level: 5, previous: 2 },
          snippet: '<h5>',
        },
      ]);
    });

    it('counts ARIA headings, and none that is hidden', () => {
      page(
        '<div role="heading" aria-level="1">A</div><h4 hidden>x</h4><h4 aria-hidden="true">y</h4><h2>B</h2>',
      );
      expect(codes()).toEqual([]);
    });
  });

  describe('tables', () => {
    it('reports rows of unequal length in a table with headers', () => {
      page(
        '<h1>A</h1><table data-ff-src="body:4:1"><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td>2</td></tr></table>',
      );
      expect(audit(window).findings).toMatchObject([
        { code: 'table-rows', src: 'body:4:1', args: { first: 3, other: 2 } },
      ]);
    });

    it('counts column and row spans', () => {
      page(
        '<h1>A</h1><table><tr><th rowspan="2">A</th><th colspan="2">B</th></tr><tr><td>1</td><td>2</td></tr>' +
          '<tr><td colspan="3">total</td></tr></table>',
      );
      expect(codes()).toEqual([]);
      const rows = Array.from(document.querySelector('table')!.rows);
      expect(rowWidths(rows)).toEqual([3, 3, 3]);
    });

    it('reports data cells without content, which Chromium does not write: once a table, at the first', () => {
      const head = '<tr><th>A</th><th>B</th><th>C</th></tr>';
      page(
        `<h1>A</h1><table>${head}<tr><td>1</td><td data-ff-src="body:6:9"></td><td> \n </td></tr>` +
          // a decoration and an image marked as one are nothing a reader is given either
          `<tr><td><span style="display:inline-block;width:8px;height:8px;background:#333"></span></td><td><img src="${px}" alt=""></td><td>3</td></tr></table>`,
      );
      expect(audit(window).findings).toMatchObject([
        {
          code: 'table-cell-empty',
          severity: 'error',
          src: 'body:6:9',
          args: { count: 4 },
        },
      ]);
    });

    it('takes a non-breaking space, an image with a text and a form control for content, and every header cell', () => {
      page(
        '<h1>A</h1><table><tr><th></th><th>B</th><th>C</th><th>D</th></tr>' +
          `<tr><th scope="row"></th><td>&nbsp;</td><td><img src="${px}" alt="yes"></td><td><input type="checkbox" aria-label="done"></td></tr>` +
          '<tr><td>&#8203;</td><td>2</td><td>3</td><td>4</td></tr></table>',
      );
      expect(codes()).toEqual([]);
    });

    it('warns about a table of several rows without a header cell, and says nothing of a layout table', () => {
      page(
        '<h1>A</h1><table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>',
      );
      expect(audit(window).findings).toMatchObject([
        { code: 'table-headers', severity: 'warning' },
      ]);
      page(
        '<h1>A</h1><table role="presentation"><tr><td>1</td></tr><tr><td>2</td></tr></table>',
      );
      expect(codes()).toEqual([]);
      page('<h1>A</h1><table><tr><td>one row</td></tr></table>');
      expect(codes()).toEqual([]);
    });
  });

  describe('links', () => {
    it('names every link as a screen reader would, in document order', () => {
      page(
        '<h1>A</h1><p><a href="https://formfeed.test/a">  Zur\n Rechnung </a>' +
          '<a href="https://formfeed.test/b" aria-label="Zahlung">hier</a>' +
          `<a href="https://formfeed.test/c"><img src="${px}" alt="Logo"></a>` +
          '<a href="#agb">AGB</a><a name="agb">kein Link</a></p>',
      );
      expect(audit(window).links).toEqual([
        { href: 'https://formfeed.test/a', name: 'Zur Rechnung' },
        { href: 'https://formfeed.test/b', name: 'Zahlung' },
        { href: 'https://formfeed.test/c', name: 'Logo' },
        { href: '#agb', name: 'AGB' },
      ]);
    });

    it('warns about a link whose description would be its address', () => {
      page(
        `<h1>A</h1><a href="https://formfeed.test/a"><img src="${px}" alt=""></a>`,
      );
      expect(audit(window)).toMatchObject({
        findings: [{ code: 'link-name', severity: 'warning' }],
        links: [{ href: 'https://formfeed.test/a', name: '' }],
      });
    });

    it('reads the links without findings when only their names are wanted', () => {
      page('<h3>no h1</h3><a href="https://formfeed.test/a">A</a>', '');
      expect(audit(window, { findings: false })).toEqual({
        findings: [],
        links: [{ href: 'https://formfeed.test/a', name: 'A' }],
        templateLinks: [],
      });
    });
  });

  describe('what CSS does to text', () => {
    it('reports a mask on text as an error and a filter as a warning, once for the outermost element', () => {
      page(
        '<h1>A</h1><div style="mask-image: linear-gradient(#000, transparent)"><p style="mask-image: linear-gradient(#000, transparent)">verläuft</p></div>' +
          '<div style="filter: grayscale(1)"><p>grau</p></div><div style="filter: blur(1px)"></div>',
      );
      expect(audit(window).findings).toMatchObject([
        {
          code: 'masked-text',
          severity: 'error',
          snippet: expect.stringContaining('<div'),
        },
        { code: 'filtered-text', severity: 'warning' },
      ]);
    });

    it('warns about fixed text only on a document of several pages', () => {
      page('<h1>A</h1><div style="position: fixed">Entwurf</div>');
      expect(codes({ pages: 1 })).toEqual([]);
      expect(codes({ pages: 3 })).toEqual(['fixed-text']);
    });

    it('reads the words a content value generates', () => {
      expect(generatedText('"Generated: "')).toBe('Generated:');
      expect(generatedText('counter(n) ") "')).toBe('counter(n) ") "');
      expect(generatedText('"\\"Zitat\\" "')).toBe('"Zitat"');
      // quotes, bullets and icon fonts say no word
      for (const silent of [
        'none',
        'normal',
        'open-quote',
        '"•"',
        '"→ "',
        '""',
      ])
        expect(generatedText(silent)).toBe('');
    });
  });

  describe('header and footer', () => {
    const footer =
      '<div>Fennlor Studio GmbH · USt-IdNr. DE000000000 · IBAN DE36 0000 0000 0000 0000 00</div>' +
      '<div>Seite <span class="pageNumber"></span> von <span class="totalPages"></span></div>';

    it('warns about what stands only there, piece by piece', () => {
      page('<h1>Rechnung</h1><p>Fennlor Studio GmbH, Musterstraße 1</p>');
      const { findings } = audit(window, { header: '', footer });
      expect(findings).toMatchObject([
        {
          code: 'running-text',
          args: { part: 'footer', text: 'USt-IdNr. DE000000000' },
        },
        {
          code: 'running-text',
          args: { part: 'footer', text: 'IBAN DE36 0000 0000 0000 0000 00' },
        },
      ]);
    });

    it('is content with a body that says the same, however it spaces it', () => {
      page(
        '<h1>Rechnung</h1><p>Fennlor Studio GmbH</p><p>ust-idnr. DE000000000</p><p>IBAN DE36000000000000000000</p>',
      );
      expect(audit(window, { footer }).findings).toEqual([]);
    });

    it('finds the previews’ own boxes, and never counts them as the body', () => {
      page(
        '<div class="formfeed-chrome" data-ff-chrome="header"><span data-ff-src="header:1:1">Vertraulich</span></div>' +
          '<h1>Rechnung</h1>' +
          '<div class="formfeed-chrome" data-ff-chrome="footer"><img src="x.png"><a href="https://formfeed.test/">formfeed.test</a></div>',
      );
      const report = audit(window);
      expect(report.findings).toMatchObject([
        {
          code: 'running-text',
          src: 'header:1:1',
          args: { part: 'header', text: 'Vertraulich' },
        },
        {
          code: 'running-text',
          args: { part: 'footer', text: 'formfeed.test' },
        },
      ]);
      // a picture in the footer is page furniture: no alt is asked of it
      expect(report.links).toEqual([]);
      expect(report.templateLinks).toEqual([
        { href: 'https://formfeed.test/', name: 'formfeed.test' },
      ]);
    });

    it('reports a piece once, though Paged.js repeats the footer on every page', () => {
      page(
        '<h1>Rechnung</h1>' +
          '<div class="ff-running-footer"><span data-ff-src="footer:1:1">IBAN DE36</span></div>'.repeat(
            3,
          ),
      );
      expect(codes()).toEqual(['running-text']);
    });
  });
});

describe('startTag', () => {
  it('is the tag as written, cut to a length a list can show', () => {
    const element = document.createElement('p');
    element.setAttribute('class', 'x'.repeat(40));
    element.setAttribute('data-note', 'y'.repeat(40));
    element.setAttribute('title', 'z'.repeat(40));
    element.textContent = 'content is not part of it';
    const tag = startTag(element);
    expect(tag.startsWith('<p class="xxx')).toBe(true);
    expect(tag).toHaveLength(120);
    expect(tag.endsWith('…')).toBe(true);
  });

  // Paged.js gives every element a reference and notes where it split and broke. A finding of the
  // paged preview once read `<h3 data-ref="0add6264-…">`, which nobody wrote.
  it('leaves out what Paged.js wrote onto an element of a page, and nothing the author wrote', () => {
    document.body.innerHTML =
      '<div class="pagedjs_page"><table class="totals" data-ref="c9c8ada9-0f83" data-split-from="x" ' +
      'data-break-before="page" data-previous-break-after="auto" data-align-last-split-element="justify" ' +
      'data-counter-reset="a 1" data-sku="A-7"></table></div>' +
      '<h3 data-ref="mine" data-id="chapter-2">Outside a page</h3>';
    expect(startTag(document.querySelector('table')!)).toBe(
      '<table class="totals" data-sku="A-7">',
    );
    // the same names in a document Paged.js never touched are the author's own
    expect(startTag(document.querySelector('h3')!)).toBe(
      '<h3 data-ref="mine" data-id="chapter-2">',
    );
  });
});
