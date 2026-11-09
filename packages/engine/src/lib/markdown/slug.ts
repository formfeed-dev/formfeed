/**
 * Heading ids by GitHub's rule (its `github-slugger`), so that `[see](#setup)` written for a README
 * links inside the PDF too: lower case, everything but letters, marks, numbers, connector punctuation
 * (`_`), hyphens and spaces removed, each space a hyphen; a second heading of the same text gets
 * `-1`, a third `-2`.
 */

const REMOVED = /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu;

export function slugOf(text: string): string {
  return text.toLowerCase().replace(REMOVED, '').replace(/ /g, '-');
}

/** Hands out the ids of one document, numbering repeats as GitHub does. */
export class Slugger {
  private readonly seen = new Map<string, number>();

  slug(text: string): string {
    const original = slugOf(text);
    let slug = original;
    while (this.seen.has(slug)) {
      const n = (this.seen.get(original) ?? 0) + 1;
      this.seen.set(original, n);
      slug = `${original}-${n}`;
    }
    this.seen.set(slug, 0);
    return slug;
  }
}
