import { createCustomApiCallAction } from '@activepieces/pieces-common';
import { createPiece, PieceCategory } from '@activepieces/pieces-framework';
import { convertToPdf } from './lib/actions/convert-to-pdf';
import { createDocument } from './lib/actions/create-document';
import { createDocumentFromHtml } from './lib/actions/create-document-from-html';
import { createDocumentFromUrl } from './lib/actions/create-document-from-url';
import { compressPdf } from './lib/actions/compress-pdf';
import { fillPdfForm } from './lib/actions/fill-pdf-form';
import { getPdfInfo } from './lib/actions/get-pdf-info';
import { getRender } from './lib/actions/get-render';
import { pdfToImage } from './lib/actions/pdf-to-image';
import { redactPdf } from './lib/actions/redact-pdf';
import { splitPdf } from './lib/actions/split-pdf';
import { uploadFile } from './lib/actions/upload-file';
import { formfeedAuth } from './lib/auth';
import { apiKeyOf, BASE_URL } from './lib/common/client';
import { batchFinished, renderCompleted, renderFailed } from './lib/triggers';

export const formfeed = createPiece({
  displayName: 'Formfeed',
  description:
    'Create PDFs, images, Word and PowerPoint documents from templates, and fill, redact, split and compress the PDFs you already have.',
  auth: formfeedAuth,
  minimumSupportedRelease: '0.82.0',
  logoUrl: 'https://formfeed.dev/brand/formfeed-512.png',
  authors: ['formfeed'],
  categories: [PieceCategory.CONTENT_AND_FILES, PieceCategory.PRODUCTIVITY],
  actions: [
    createDocument,
    createDocumentFromHtml,
    createDocumentFromUrl,
    getRender,
    convertToPdf,
    getPdfInfo,
    fillPdfForm,
    redactPdf,
    splitPdf,
    compressPdf,
    pdfToImage,
    uploadFile,
    createCustomApiCallAction({
      auth: formfeedAuth,
      baseUrl: () => BASE_URL,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${apiKeyOf(auth)}`,
      }),
    }),
  ],
  triggers: [renderCompleted, renderFailed, batchFinished],
});
