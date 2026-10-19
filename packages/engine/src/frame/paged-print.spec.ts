// @vitest-environment jsdom
import {
  anchorFixed,
  moveTableFeet,
  repeatFoot,
  repeatHead,
  settleTable,
} from './paged-print';

/**
 * What the runtime does to the page's markup. Where the rows end up is layout, which jsdom has none
 * of: the render-worker's `paged-preview.spec.ts` lays the blog post's 21 tables out with Paged.js in
 * Chromium and holds every page to the PDF.
 */
const style = (css: string) => {
  document.head.innerHTML = `<style>${css}</style>`;
};
const GROUPS =
  'thead { display: table-header-group; } tbody { display: table-row-group; } tfoot { display: table-footer-group; }';

/** Paged.js's source of a table, and a page that holds its rebuilt continuation, as Paged.js leaves them. */
function continued(headCss = GROUPS) {
  style(headCss);
  document.body.innerHTML = `
<div id="source"><table data-ref="t"><colgroup data-ref="c"><col></colgroup><thead data-ref="h"><tr data-ref="hr"><th id="col-a" data-ref="th">Pos</th></tr></thead>
<tbody data-ref="b"><tr data-ref="r1" data-break-inside="avoid"><td data-ref="d1">1</td></tr><tr data-ref="r2" data-break-inside="avoid"><td data-ref="d2">2</td></tr></tbody>
<tfoot data-ref="f"><tr data-ref="fr"><td data-ref="fd">Total</td></tr></tfoot></table></div>
<div class="pagedjs_page_content"><div id="wrap"><table data-ref="t" data-split-from="t"><tbody data-ref="b" data-split-from="b"><tr data-ref="r2" data-break-inside="avoid"><td data-ref="d2">2</td></tr></tbody></table></div></div>`;
  const source = document.querySelector('#source tr[data-ref="r2"]')!;
  const page = document.querySelector('.pagedjs_page_content table')!;
  return { source, page, row: page.querySelector('tr') as HTMLElement };
}

describe("the paged preview's tables", () => {
  it('moves a footer group written before the body to the end, where Chromium draws it', () => {
    style(GROUPS);
    document.body.innerHTML =
      '<table id="a"><thead><tr><th>h</th></tr></thead><tfoot><tr><td>sum</td></tr></tfoot><tbody><tr><td>1</td></tr></tbody></table>' +
      '<table id="b" style=""><tfoot style="display: table-row-group"><tr><td>first</td></tr></tfoot><tbody><tr><td>1</td></tr></tbody></table>';
    moveTableFeet(document, window);
    expect(
      [...document.querySelector('#a')!.children].map((c) => c.nodeName),
    ).toEqual(['THEAD', 'TBODY', 'TFOOT']);
    // made a row group by the template, it prints where it stands
    expect(
      [...document.querySelector('#b')!.children].map((c) => c.nodeName),
    ).toEqual(['TFOOT', 'TBODY']);
  });

  it('puts the head in front of a table that goes on from the page before, once', () => {
    const { source, page, row } = continued();
    repeatHead(row, source, window);
    expect([...page.children].map((c) => c.nodeName)).toEqual([
      'COLGROUP',
      'THEAD',
      'TBODY',
    ]);
    const head = page.querySelector('thead')!;
    expect(head.hasAttribute('data-ff-repeated')).toBe(true);
    // an id belongs to the first page's head
    expect(head.querySelector('th')!.id).toBe('');
    expect(head.querySelector('th')!.getAttribute('data-id')).toBe('col-a');
    // the row under it is at the top of its page now, and may break there as in Chromium
    expect(row.style.breakInside).toBe('auto');
    expect(row.hasAttribute('data-break-inside')).toBe(false);
    repeatHead(row.firstChild!, source.firstChild!, window);
    expect(page.querySelectorAll('thead')).toHaveLength(1);
  });

  it('repeats no head that Chromium does not repeat', () => {
    const block = continued(`${GROUPS} thead { display: block; }`);
    repeatHead(block.row, block.source, window);
    expect(block.page.querySelector('thead')).toBeNull();
    expect(block.row.style.breakInside).toBe('');

    const sliced = continued();
    (document.querySelector('#wrap') as HTMLElement).style.display =
      'inline-block';
    repeatHead(sliced.row, sliced.source, window);
    expect(sliced.page.querySelector('thead')).toBeNull();

    // a table that starts on this page has its own head
    const first = continued();
    first.page.removeAttribute('data-split-from');
    repeatHead(first.row, first.source, window);
    expect(first.page.querySelector('thead')).toBeNull();
  });

  it("adds the footer group's copy to the table it kept room on", () => {
    const { page } = continued();
    page.setAttribute('data-ff-foot', '');
    repeatFoot(
      document.querySelector('.pagedjs_page_content')!,
      document.querySelector('#source')!,
    );
    expect(page.hasAttribute('data-ff-foot')).toBe(false);
    expect(page.lastElementChild!.nodeName).toBe('TFOOT');
    expect(page.lastElementChild!.hasAttribute('data-ff-repeated')).toBe(true);
  });

  it('moves a head with no row under it on, with a heading kept to its table', () => {
    style(GROUPS);
    document.body.innerHTML = `<div class="pagedjs_page_content"><p>Intro</p><h2 id="h">Items</h2>
<table data-ref="t" data-previous-break-after="avoid"><thead><tr><th>Pos</th></tr></thead><tbody><tr id="first"><td>1</td></tr></tbody></table></div>`;
    const rendered = document.querySelector('.pagedjs_page_content')!;
    const overflow = document.createRange();
    overflow.setStartBefore(document.querySelector('#first')!);
    overflow.setEndAfter(rendered.lastChild!);
    expect(settleTable(overflow, rendered, 1000, document, window)).toBe(
      overflow,
    );
    expect(overflow.startContainer).toBe(rendered);
    expect(rendered.childNodes[overflow.startOffset]).toBe(
      document.querySelector('#h'),
    );
  });

  it('measures a fixed element from the page area, as Chromium does, not from the sheet', () => {
    document.body.innerHTML = `<div class="pagedjs_page"><div class="pagedjs_pagebox"><div class="fixed" style="position: absolute">FIXED</div>
<div class="pagedjs_margin-top"></div><div class="pagedjs_area"><div class="pagedjs_page_content"><p>Text</p></div></div></div></div>`;
    const page = document.querySelector('.pagedjs_page')!;
    anchorFixed(page);
    const layer = document.querySelector('[data-ff-fixed]') as HTMLElement;
    // in the grid cell of the page area, over it, and a box for `bottom: 0` to measure from
    expect(layer.style.gridColumn).toBe('center');
    expect(layer.style.gridRow).toBe('page');
    expect(layer.style.position).toBe('relative');
    expect(layer.querySelector('.fixed')).not.toBeNull();
    // clicks reach the page under the layer, and the element in it
    expect(layer.style.pointerEvents).toBe('none');
    expect(
      (layer.querySelector('.fixed') as HTMLElement).style.pointerEvents,
    ).toBe('auto');
    // Paged.js's own boxes stay, and a second call moves nothing twice
    anchorFixed(page);
    expect(document.querySelectorAll('[data-ff-fixed]')).toHaveLength(1);
    expect(
      document.querySelector('.pagedjs_pagebox > .pagedjs_area'),
    ).not.toBeNull();
  });

  it('leaves a table alone that starts its page or goes on from the one before', () => {
    style(GROUPS);
    document.body.innerHTML = `<div class="pagedjs_page_content"><table data-ref="t"><thead><tr><th>Pos</th></tr></thead><tbody><tr id="first"><td>1</td></tr></tbody></table></div>`;
    const rendered = document.querySelector('.pagedjs_page_content')!;
    const overflow = document.createRange();
    overflow.setStartBefore(document.querySelector('#first')!);
    overflow.setEndAfter(rendered.lastChild!);
    // moving it on would leave this page empty and the next one the same
    expect(
      settleTable(overflow, rendered, 1000, document, window),
    ).toBeUndefined();

    document.querySelector('table')!.setAttribute('data-split-from', 't');
    document.body.firstElementChild!.insertAdjacentHTML(
      'afterbegin',
      '<p>Before</p>',
    );
    expect(
      settleTable(overflow, rendered, 1000, document, window),
    ).toBeUndefined();
  });
});
