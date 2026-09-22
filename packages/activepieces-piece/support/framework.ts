/**
 * The framework as the piece imports it in Activepieces' monorepo, where `PieceCategory` comes from
 * `@activepieces/pieces-framework`. The newest release on npm (0.32.0) still leaves it in
 * `@activepieces/shared`, so the typecheck and the tests here map the framework to this file
 * (tsconfig `paths`, vitest `alias`) and the piece's source stays as their repository wants it.
 */
export * from '@activepieces/pieces-framework/src/index';
export { PieceCategory } from '@activepieces/shared';
