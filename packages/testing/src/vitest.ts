/** Vitest setup file: `setupFiles: ['@formfeed/testing/vitest']`. */
import { expect } from 'vitest';
import { matchers, type FormfeedMatchers } from './lib/testing';

expect.extend(matchers);

// `Matchers`, not `Assertion`: Vitest re-exports both from @vitest/expect, and only an augmented
// `Matchers` merges through that re-export (the form Vitest documents since 3.2). `Assertion` and
// the `expect.*` statics both extend it. An `Assertion` augmentation compiles but adds nothing, so a
// user's `expect(tpl).toRenderWithoutErrors()` was a type error; tools/publish/smoke.mjs checks it.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-empty-interface, @typescript-eslint/no-unused-vars
  interface Matchers<T = any> extends FormfeedMatchers<void> {}
}
