/**
 * The Google Fonts a design can pick (plan 16 §4.2, §9): a curated list, so the one `@import` the
 * emitter writes only ever names families and weights Google serves — an unknown family or a weight
 * a family lacks makes Google answer 400, and every font of the design would be missing. The
 * render-worker's asset cache serves the stylesheet and the files like any other Google Fonts request.
 */
export interface GoogleFont {
  family: string;
  category: 'sans-serif' | 'serif' | 'display' | 'monospace' | 'handwriting';
  weights: number[];
  italic: boolean;
}

const range = (from: number, to: number) =>
  Array.from({ length: (to - from) / 100 + 1 }, (_, i) => from + i * 100);

export const googleFonts: GoogleFont[] = [
  {
    family: 'Inter',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Roboto',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Open Sans',
    category: 'sans-serif',
    weights: range(300, 800),
    italic: true,
  },
  {
    family: 'Lato',
    category: 'sans-serif',
    weights: [100, 300, 400, 700, 900],
    italic: true,
  },
  {
    family: 'Montserrat',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Poppins',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Source Sans 3',
    category: 'sans-serif',
    weights: range(200, 900),
    italic: true,
  },
  {
    family: 'Nunito',
    category: 'sans-serif',
    weights: range(200, 900),
    italic: true,
  },
  {
    family: 'Raleway',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Work Sans',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'DM Sans',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Manrope',
    category: 'sans-serif',
    weights: range(200, 800),
    italic: false,
  },
  {
    family: 'Rubik',
    category: 'sans-serif',
    weights: range(300, 900),
    italic: true,
  },
  {
    family: 'Noto Sans',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'IBM Plex Sans',
    category: 'sans-serif',
    weights: range(100, 700),
    italic: true,
  },
  {
    family: 'Space Grotesk',
    category: 'sans-serif',
    weights: range(300, 700),
    italic: false,
  },
  {
    family: 'Outfit',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: false,
  },
  {
    family: 'Plus Jakarta Sans',
    category: 'sans-serif',
    weights: range(200, 800),
    italic: true,
  },
  {
    family: 'Figtree',
    category: 'sans-serif',
    weights: range(300, 900),
    italic: true,
  },
  {
    family: 'Karla',
    category: 'sans-serif',
    weights: range(200, 800),
    italic: true,
  },
  {
    family: 'Barlow',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Archivo',
    category: 'sans-serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Oswald',
    category: 'display',
    weights: range(200, 700),
    italic: false,
  },
  { family: 'Bebas Neue', category: 'display', weights: [400], italic: false },
  { family: 'Anton', category: 'display', weights: [400], italic: false },
  {
    family: 'Playfair Display',
    category: 'serif',
    weights: range(400, 900),
    italic: true,
  },
  {
    family: 'Merriweather',
    category: 'serif',
    weights: range(300, 900),
    italic: true,
  },
  { family: 'Lora', category: 'serif', weights: range(400, 700), italic: true },
  {
    family: 'Libre Baskerville',
    category: 'serif',
    weights: [400, 700],
    italic: true,
  },
  {
    family: 'Source Serif 4',
    category: 'serif',
    weights: range(200, 900),
    italic: true,
  },
  {
    family: 'EB Garamond',
    category: 'serif',
    weights: range(400, 800),
    italic: true,
  },
  {
    family: 'Cormorant Garamond',
    category: 'serif',
    weights: range(300, 700),
    italic: true,
  },
  {
    family: 'DM Serif Display',
    category: 'serif',
    weights: [400],
    italic: true,
  },
  {
    family: 'Fraunces',
    category: 'serif',
    weights: range(100, 900),
    italic: true,
  },
  {
    family: 'Roboto Slab',
    category: 'serif',
    weights: range(100, 900),
    italic: false,
  },
  {
    family: 'Zilla Slab',
    category: 'serif',
    weights: [300, 400, 500, 600, 700],
    italic: true,
  },
  {
    family: 'JetBrains Mono',
    category: 'monospace',
    weights: range(100, 800),
    italic: true,
  },
  {
    family: 'IBM Plex Mono',
    category: 'monospace',
    weights: range(100, 700),
    italic: true,
  },
  {
    family: 'Space Mono',
    category: 'monospace',
    weights: [400, 700],
    italic: true,
  },
  {
    family: 'Caveat',
    category: 'handwriting',
    weights: range(400, 700),
    italic: false,
  },
  {
    family: 'Pacifico',
    category: 'handwriting',
    weights: [400],
    italic: false,
  },
  {
    family: 'Dancing Script',
    category: 'handwriting',
    weights: range(400, 700),
    italic: false,
  },
];

const byFamily = new Map(googleFonts.map((font) => [font.family, font]));

export function googleFont(family: string): GoogleFont | undefined {
  return byFamily.get(family);
}

/** The generic family a font falls back to in CSS. */
export function genericFamily(font: GoogleFont | undefined): string {
  if (!font) return 'sans-serif';
  return font.category === 'serif'
    ? 'serif'
    : font.category === 'monospace'
      ? 'monospace'
      : font.category === 'handwriting'
        ? 'cursive'
        : 'sans-serif';
}

/** The weight a family serves that is closest to the one asked for (heavier on a tie). */
export function nearestWeight(font: GoogleFont, weight: number): number {
  return font.weights.reduce(
    (best, w) =>
      Math.abs(w - weight) < Math.abs(best - weight) ||
      (Math.abs(w - weight) === Math.abs(best - weight) && w > best)
        ? w
        : best,
    font.weights[0] ?? 400,
  );
}

/**
 * One stylesheet URL for every family, weight and style a design uses, or null when it uses none.
 * `display=block`, so a capture never shows a fallback font.
 */
export function googleFontsUrl(
  uses: Array<{ family: string; weight: number; italic: boolean }>,
): string | null {
  const wanted = new Map<string, Set<string>>();
  for (const use of uses) {
    const font = byFamily.get(use.family);
    if (!font) continue;
    const italic = use.italic && font.italic ? 1 : 0;
    const set = wanted.get(font.family) ?? new Set<string>();
    set.add(`${italic},${nearestWeight(font, use.weight)}`);
    wanted.set(font.family, set);
  }
  if (!wanted.size) return null;
  const families = [...wanted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, set]) => {
      const tuples = [...set]
        .map((t) => t.split(',').map(Number) as [number, number])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const name = family.replace(/ /g, '+');
      return tuples.some(([italic]) => italic)
        ? `family=${name}:ital,wght@${tuples.map(([i, w]) => `${i},${w}`).join(';')}`
        : `family=${name}:wght@${tuples.map(([, w]) => w).join(';')}`;
    });
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=block`;
}
