import type { AuditOptions, AuditReport } from '../lib/accessibility';
import { audit } from './audit';

// The host decides when the document is ready and what to do with the report: the previews post it
// to the editor, the render-worker reads it as the script's own answer.
(
  window as unknown as {
    formfeedAudit?: (options?: AuditOptions) => AuditReport;
  }
).formfeedAudit = (options) => audit(window, options);
