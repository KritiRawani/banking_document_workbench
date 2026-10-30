import { Worker } from 'node:worker_threads';
import { UploadError } from './errors.js';
import type { Extraction } from './types.js';

export const MAX_TEXT_CHARACTERS = 1_000_000;

export function extractTxt(buffer: Buffer): Extraction {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new UploadError('INVALID_TEXT_ENCODING', 'TXT documents must use valid UTF-8 encoding.'); }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new UploadError('INVALID_TEXT_CONTENT', 'TXT document contains binary or unsupported control characters.');
  }
  if (!text.trim()) throw new UploadError('EMPTY_TEXT', 'Document contains no readable text.');
  if (text.length > MAX_TEXT_CHARACTERS) {
    throw new UploadError('TEXT_LIMIT_EXCEEDED', 'Extracted text exceeds the 1,000,000-character limit.');
  }
  return { text, metadata: { parser: 'TextDecoder', encoding: 'utf-8', character_count: text.length } };
}

// The worker isolates synchronous parsing so a corrupt PDF cannot block the API.
// Only byte data is supplied: PDF.js never receives a file path or remote URL.
const pdfWorker = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({data: new Uint8Array(workerData), isEvalSupported: false,
    useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: true});
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100) throw {code: 'PDF_PAGE_LIMIT', message: 'PDF exceeds the 100-page limit.'};
    let text = '';
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.filter(item => 'str' in item)
        .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
      if (text.length + pageText.length + 2 > 1000000)
        throw {code:'TEXT_LIMIT_EXCEEDED', message:'Extracted text exceeds the 1,000,000-character limit.'};
      if (pageNumber > 1) text += '\n\n';
      const start = text.length;
      text += pageText;
      pages.push({page:pageNumber, char_start:start, char_end:text.length});
      page.cleanup();
    }
    if (!text.trim()) throw {code:'NO_EXTRACTABLE_TEXT', message:'PDF has no extractable text. Scanned documents require OCR, which is not supported yet.'};
    parentPort.postMessage({ok:true, extraction:{text, metadata:{parser:'pdfjs-dist',
      page_count:pdf.numPages, pages, character_count:text.length, ocr_used:false}}});
  } finally { await task.destroy(); }
})().catch(error => {
  const known = ['PDF_PAGE_LIMIT','TEXT_LIMIT_EXCEEDED','NO_EXTRACTABLE_TEXT'];
  const encrypted = error && error.name === 'PasswordException';
  parentPort.postMessage({ok:false, code:known.includes(error?.code) ? error.code : encrypted ? 'ENCRYPTED_PDF' : 'INVALID_PDF',
    message:known.includes(error?.code) ? error.message : encrypted ? 'Password-protected PDFs are not supported.' : 'PDF is corrupt or unreadable.'});
});
`;

export function extractPdf(buffer: Buffer): Promise<Extraction> {
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return Promise.reject(new UploadError('INVALID_PDF', 'File does not have a valid PDF header.'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(pdfWorker, {
      eval: true, workerData: buffer, resourceLimits: { maxOldGenerationSizeMb: 128 },
      stdout: true, stderr: true,
    });
    // Discard parser warnings; document contents and parser internals are private.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error?: UploadError, extraction?: Extraction) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error); else resolve(extraction!);
    };
    const timeout = setTimeout(() => finish(new UploadError('PDF_TIMEOUT', 'PDF extraction exceeded the 15-second limit.')), 15_000);
    worker.once('message', (result: { ok: boolean; extraction?: Extraction; code: string; message: string }) => {
      if (result.ok && result.extraction) finish(undefined, result.extraction);
      else finish(new UploadError(result.code, result.message));
    });
    worker.once('error', () => finish(new UploadError('INVALID_PDF', 'PDF could not be processed safely.')));
    worker.once('exit', () => { if (!settled) finish(new UploadError('INVALID_PDF', 'PDF extraction stopped unexpectedly.')); });
  });
}
