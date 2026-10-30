export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;

export interface UploadedDocument {
  id: string;
  original_filename: string;
  file_size_bytes: string;
  processing_status: 'uploaded' | 'processing' | 'ready' | 'failed';
  extracted_text: string | null;
  error_message: string | null;
}

export interface UploadResult {
  filename: string;
  outcome: 'ready' | 'duplicate' | 'failed' | 'rejected';
  document?: UploadedDocument;
  error?: { code: string; message: string };
}

export function validateFile(file: File): string | undefined {
  const dot = file.name.lastIndexOf('.');
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  if (extension !== 'pdf' && extension !== 'txt') return 'Only PDF and TXT files are supported.';
  const expectedType = extension === 'pdf' ? 'application/pdf' : 'text/plain';
  if (file.type && file.type !== expectedType && file.type !== 'application/octet-stream') {
    return 'File extension and content type do not match.';
  }
  if (file.size === 0) return 'Empty files cannot be uploaded.';
  if (file.size > MAX_FILE_BYTES) return 'File exceeds the 10 MiB limit.';
  return undefined;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isUploadResult(value: unknown): value is UploadResult {
  if (!isObject(value) || typeof value.filename !== 'string' ||
    !['ready', 'duplicate', 'failed', 'rejected'].includes(String(value.outcome))) return false;
  if (value.error !== undefined && (!isObject(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string')) return false;
  if (value.document !== undefined) {
    const doc = value.document;
    if (!isObject(doc) || typeof doc.id !== 'string' || typeof doc.original_filename !== 'string' ||
      typeof doc.file_size_bytes !== 'string' || !/^\d+$/.test(doc.file_size_bytes) ||
      !['uploaded', 'processing', 'ready', 'failed'].includes(String(doc.processing_status)) ||
      !(doc.extracted_text === null || typeof doc.extracted_text === 'string') ||
      !(doc.error_message === null || typeof doc.error_message === 'string')) return false;
  }
  return (value.outcome === 'ready' || value.outcome === 'duplicate') ? value.document !== undefined : value.error !== undefined;
}
