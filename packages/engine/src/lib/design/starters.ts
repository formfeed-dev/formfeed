import {
  DESIGN_VERSION,
  type CanvasSize,
  type DesignDocument,
  type TextLayer,
  type TextStyle,
} from './types';

/**
 * Designs a new image template can start from (plan 16 §4.2). Titles stay English here; the app words
 * them per locale by `id`. Sample data uses the placeholders of CLAUDE.md, never names that could be
 * real.
 */
export interface DesignStarter {
  id: 'blank' | 'article' | 'quote' | 'event';
  title: string;
  size: CanvasSize;
  design: DesignDocument;
  sampleData: Record<string, unknown>;
}

const style = (overrides: Partial<TextStyle>): TextStyle => ({
  font: { family: 'Inter', source: 'google' },
  weight: 600,
  size: 40,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: { color: '#111827' },
  align: 'left',
  ...overrides,
});

const text = (
  layer: Omit<
    TextLayer,
    'type' | 'rotation' | 'opacity' | 'visible' | 'sizing' | 'valign'
  > &
    Partial<TextLayer>,
): TextLayer => ({
  type: 'text',
  rotation: 0,
  opacity: 1,
  visible: true,
  sizing: 'fixed',
  valign: 'top',
  ...layer,
});

const design = (
  background: DesignDocument['background'],
  layers: DesignDocument['layers'],
): DesignDocument => ({
  version: DESIGN_VERSION,
  output: '',
  background,
  layers,
});

export const designStarters: DesignStarter[] = [
  {
    id: 'blank',
    title: 'Blank',
    size: { width: 1200, height: 630 },
    design: design({ color: '#ffffff' }, []),
    sampleData: {},
  },
  {
    id: 'article',
    title: 'Article card',
    size: { width: 1200, height: 630 },
    design: design({ brand: 'primary', fallback: '#0f172a' }, [
      text({
        id: 'site',
        name: 'Site',
        x: 80,
        y: 64,
        width: 1040,
        height: 40,
        content: [{ path: 'site.name' }],
        style: style({
          size: 26,
          weight: 600,
          letterSpacing: 2,
          uppercase: true,
          color: { color: '#cbd5e1' },
        }),
      }),
      text({
        id: 'title',
        name: 'Title',
        x: 80,
        y: 130,
        width: 1040,
        height: 320,
        content: [{ path: 'post.title' }],
        sizing: 'shrink',
        minFontSize: 40,
        valign: 'middle',
        style: style({
          size: 76,
          weight: 800,
          lineHeight: 1.1,
          color: { color: '#ffffff' },
        }),
      }),
      {
        id: 'rule',
        name: 'Rule',
        type: 'shape',
        shape: 'rectangle',
        x: 80,
        y: 478,
        width: 120,
        height: 6,
        rotation: 0,
        opacity: 1,
        visible: true,
        fill: { brand: 'accent', fallback: '#38bdf8' },
      },
      text({
        id: 'byline',
        name: 'Byline',
        x: 80,
        y: 508,
        width: 1040,
        height: 50,
        content: [{ text: 'By ' }, { path: 'post.author' }],
        showWhen: { path: 'post.author' },
        style: style({ size: 30, weight: 500, color: { color: '#cbd5e1' } }),
      }),
    ]),
    sampleData: {
      site: { name: 'Fennlor Studio' },
      post: {
        title: 'How we cut our invoice run from an hour to four minutes',
        author: 'Max Mustermann',
      },
    },
  },
  {
    id: 'quote',
    title: 'Quote card',
    size: { width: 1080, height: 1080 },
    design: design({ color: '#f5efe6' }, [
      text({
        id: 'mark',
        name: 'Quotation mark',
        x: 96,
        y: 60,
        width: 240,
        height: 220,
        content: [{ text: '“' }],
        style: style({
          font: { family: 'Playfair Display', source: 'google' },
          size: 220,
          weight: 700,
          lineHeight: 1,
          color: { color: '#d97706' },
        }),
      }),
      text({
        id: 'quote',
        name: 'Quote',
        x: 96,
        y: 260,
        width: 888,
        height: 520,
        content: [{ path: 'review.quote' }],
        sizing: 'shrink',
        minFontSize: 32,
        valign: 'middle',
        style: style({
          font: { family: 'Playfair Display', source: 'google' },
          size: 60,
          weight: 600,
          lineHeight: 1.22,
          color: { color: '#1c1917' },
        }),
      }),
      text({
        id: 'author',
        name: 'Author',
        x: 96,
        y: 836,
        width: 888,
        height: 50,
        content: [{ path: 'review.author' }],
        style: style({ size: 36, weight: 600, color: { color: '#1c1917' } }),
      }),
      text({
        id: 'role',
        name: 'Role',
        x: 96,
        y: 896,
        width: 888,
        height: 44,
        content: [{ path: 'review.role' }],
        showWhen: { path: 'review.role' },
        style: style({ size: 28, weight: 400, color: { color: '#78716c' } }),
      }),
    ]),
    sampleData: {
      review: {
        quote:
          'Delivery took two days, and the one shade that arrived dented was replaced before we had finished the call.',
        author: 'Erika Mustermann',
        role: 'Office manager, Olvarest GmbH',
      },
    },
  },
  {
    id: 'event',
    title: 'Event story',
    size: { width: 1080, height: 1920 },
    design: design({ color: '#111827' }, [
      text({
        id: 'label',
        name: 'Label',
        x: 96,
        y: 200,
        width: 888,
        height: 50,
        content: [{ text: 'Event' }],
        style: style({
          size: 36,
          weight: 700,
          letterSpacing: 6,
          uppercase: true,
          color: { color: '#fbbf24' },
        }),
      }),
      text({
        id: 'title',
        name: 'Title',
        x: 96,
        y: 290,
        width: 888,
        height: 620,
        content: [{ path: 'event.title' }],
        sizing: 'shrink',
        minFontSize: 56,
        valign: 'bottom',
        style: style({
          size: 112,
          weight: 800,
          lineHeight: 1.05,
          color: { color: '#ffffff' },
        }),
      }),
      text({
        id: 'date',
        name: 'Date',
        x: 96,
        y: 980,
        width: 888,
        height: 70,
        content: [
          {
            path: 'event.date',
            format: { helper: 'date', pattern: 'd MMMM yyyy' },
          },
        ],
        style: style({ size: 52, weight: 600, color: { color: '#e5e7eb' } }),
      }),
      text({
        id: 'place',
        name: 'Place',
        x: 96,
        y: 1060,
        width: 888,
        height: 60,
        content: [{ path: 'event.place' }],
        style: style({ size: 38, weight: 400, color: { color: '#9ca3af' } }),
      }),
      {
        id: 'qr',
        name: 'QR code',
        type: 'qr',
        x: 96,
        y: 1440,
        width: 300,
        height: 300,
        rotation: 0,
        opacity: 1,
        visible: true,
        radius: 16,
        value: { path: 'event.url' },
        ecc: 'M',
        color: { color: '#111827' },
        background: { color: '#ffffff' },
      },
      text({
        id: 'scan',
        name: 'Scan note',
        x: 440,
        y: 1560,
        width: 544,
        height: 60,
        content: [{ text: 'Scan for your ticket' }],
        style: style({ size: 40, weight: 600, color: { color: '#ffffff' } }),
      }),
    ]),
    sampleData: {
      event: {
        title: 'Formfeed meetup: documents as code',
        date: '2026-11-12',
        place: 'Musterstraße 1 · 12345 Musterstadt',
        url: 'https://fennlor.test/events/meetup',
      },
    },
  },
];
