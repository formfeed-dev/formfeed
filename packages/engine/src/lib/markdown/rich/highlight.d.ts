// highlight.js types its core through its main entry only; `lib/core` has no typings of its own.
// Its languages are typed by the wildcard module in its main entry's declarations, which the import
// of `highlight.js` below loads. Kept here, not in `src/types/modules.d.ts`, which the published
// package's entry references: highlight.js is no dependency of the published package (plan 33 §9).
declare module 'highlight.js/lib/core' {
  import type { HLJSApi } from 'highlight.js';

  const hljs: HLJSApi;
  export default hljs;
}

// the common set, which `code.spec.ts` compares the languages taken with
declare module 'highlight.js/lib/common' {
  import type { HLJSApi } from 'highlight.js';

  const hljs: HLJSApi;
  export default hljs;
}
