import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkInvoice } from './check';
import { displayCheck } from './display';
import { htmlText } from './html-text';

const invoice = () => {
  const check = checkInvoice(
    JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'simple.json'), 'utf8'),
    ),
  );
  if (!check.ok) throw new Error('the fixture does not pass');
  return check.invoice;
};

describe('htmlText', () => {
  it('keeps two table cells two amounts and an amount in two spans one', () => {
    const text = htmlText(
      '<table><tr><td>3.160,00</td><td>600,40</td></tr></table>' +
        '<p>Gesamt <strong>3.760</strong><span>,40</span> €</p>',
    );
    expect(text).toBe('3.160,00\n600,40\nGesamt 3.760,40 €');
  });

  it('leaves out what is not text of the page', () => {
    const text = htmlText(
      '<html><head><title>999,99</title><style>.a::after{content:"1,00"}</style></head>' +
        '<body><!-- 2,00 --><script>var total = "3,00";</script>' +
        '<template><p>4,00</p></template><h1>Rechnung</h1></body></html>',
    );
    expect(text).toBe('Rechnung');
  });

  it('decodes references, and reads a tag whose attribute holds a bracket', () => {
    const nbsp = String.fromCodePoint(0xa0);
    const euro = String.fromCodePoint(0x20ac);
    expect(
      htmlText(
        '<p title="a > b">1&nbsp;234,56&nbsp;&euro; &amp; &#8364; &#x20ac; &unknown;</p>',
      ),
    ).toBe(`1${nbsp}234,56${nbsp}${euro} & ${euro} ${euro} &unknown;`);
  });

  it('breaks the line at <br> and collapses white space inside one', () => {
    expect(htmlText('<p>Rechnung   RE-1<br>vom\n  10.09.2026</p>')).toBe(
      'Rechnung RE-1\nvom\n10.09.2026',
    );
  });

  it('gives the display check what it needs: a document that prints the invoice shows it', () => {
    const page =
      '<h1>Rechnung <span>RE-2026-0042</span></h1>' +
      '<table><tr><td>Netto</td><td class="num">3.160,00&nbsp;€</td></tr>' +
      '<tr><td>USt. 19 %</td><td class="num">600,40&nbsp;€</td></tr>' +
      '<tr><td>Gesamt</td><td class="num">3.760,40&nbsp;€</td></tr></table>';
    expect(displayCheck(htmlText(page), invoice()).missing).toEqual([]);
    // the same page with its own number in the heading
    expect(
      displayCheck(
        htmlText(page.replace('RE-2026-0042', '2026-0042')),
        invoice(),
      ).missing,
    ).toEqual(['BT-1']);
  });
});
