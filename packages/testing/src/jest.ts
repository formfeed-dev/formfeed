/** Jest setup file: `setupFilesAfterEnv: ['@formfeed/testing/jest']`. */
import { matchers, type FormfeedMatchers } from './lib/testing';

declare const expect: { extend(m: Record<string, unknown>): void };
expect.extend(matchers as unknown as Record<string, unknown>);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-empty-interface, @typescript-eslint/no-unused-vars
    interface Matchers<R> extends FormfeedMatchers<R> {}
  }
}
