/**
 * The hash a design keeps of the body and CSS the emitter wrote (plan 16 §4.5): equal means the design
 * still owns the code, different means someone edited it. It detects edits and defends nothing, so a
 * fast non-cryptographic hash does: two FNV-1a passes with different offsets, 64 bits as hex.
 */
export function designOutputHash(html: string, css: string): string {
  const text = `${html}\u0000${css}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // the emitter writes no carriage return, so a checkout that turned its line ends into CRLF is no edit
    if (code === 13) continue;
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193) >>> 0;
    b = (b + (a >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
