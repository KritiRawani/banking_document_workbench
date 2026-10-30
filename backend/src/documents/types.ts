export interface Extraction {
  text: string;
  metadata: Record<string, unknown>;
}

export interface DocumentRecord {
  id: string;
  original_filename: string;
  mime_type: string;
  file_size_bytes: string;
  sha256: string;
  processing_status: 'uploaded' | 'processing' | 'ready' | 'failed';
  extracted_text: string | null;
  extraction_metadata: unknown;
  error_message: string | null;
  created_at: unknown;
  processed_at: unknown;
}

export interface NewDocument {
  filename: string;
  storageKey: string;
  mimeType: string;
  size: number;
  hash: string;
}

export interface DocumentStore {
  findByHash(hash: string): Promise<DocumentRecord | undefined>;
  create(document: NewDocument): Promise<string>;
  finish(id: string, extraction: Extraction | null, error: string | null): Promise<DocumentRecord>;
}

export interface DocumentRepository {
  withHashLock<T>(hash: string, action: (store: DocumentStore) => Promise<T>): Promise<T>;
}

export interface UploadResult {
  filename: string;
  outcome: 'ready' | 'duplicate' | 'failed' | 'rejected';
  document?: DocumentRecord;
  error?: { code: string; message: string };
}
