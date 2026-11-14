import { HttpMethod } from '@activepieces/pieces-common';
import FormData from 'form-data';
import { formfeedRequest } from './client';
import { PDF_TOOLS, type PdfFile, type PdfTool } from './pdf-tools';
import { formValue } from './utils';

/**
 * One call of a PDF tool: JSON naming the stored `source`, or `multipart/form-data` with the file,
 * whose other fields are text (JSON text where they are not, so redact's `fill: null` is `null`).
 */
export async function pdfToolRequest<T>(
  auth: unknown,
  tool: PdfTool,
  fields: Record<string, unknown>,
  file?: PdfFile,
): Promise<T> {
  const path = PDF_TOOLS[tool];
  if (!file)
    return formfeedRequest<T>({
      auth,
      method: HttpMethod.POST,
      path,
      body: fields,
    });
  const form = new FormData();
  form.append('file', file.data, { filename: file.filename || 'document.pdf' });
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) form.append(key, formValue(value));
  return formfeedRequest<T>({
    auth,
    method: HttpMethod.POST,
    path,
    body: form,
    headers: form.getHeaders(),
  });
}
