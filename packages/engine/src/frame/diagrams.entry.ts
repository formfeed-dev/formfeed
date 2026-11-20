import {
  drawDiagrams,
  type DiagramsOutcome,
  type MermaidApi,
} from './diagrams';

// Runs at the end of the body, after Mermaid's script in the head: the render-worker awaits the
// answer before it prints, and reads it as data, so the promise never rejects.
const page = window as unknown as {
  mermaid?: MermaidApi;
  formfeedDiagrams?: Promise<DiagramsOutcome>;
};
page.formfeedDiagrams = drawDiagrams(window, page.mermaid).catch(
  (e: unknown): DiagramsOutcome => ({
    unavailable: e instanceof Error ? e.message : String(e),
  }),
);
