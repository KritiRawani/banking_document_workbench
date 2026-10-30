import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { UploadError } from './errors.js';
import type { DocumentRecord, DocumentRepository, DocumentStore } from './types.js';

// Deliberately exclude storage_key from every API-facing projection.
const columns = `CAST(id AS CHAR) AS id, original_filename, mime_type,
  CAST(file_size_bytes AS CHAR) AS file_size_bytes, sha256, processing_status,
  extracted_text, extraction_metadata, error_message, created_at, processed_at`;
interface DocumentRow extends RowDataPacket, DocumentRecord {}

function storeFor(connection: PoolConnection): DocumentStore {
  return {
    async findByHash(hash) {
      const [rows] = await connection.execute<DocumentRow[]>(
        `SELECT ${columns} FROM documents WHERE sha256 = ? ORDER BY id LIMIT 1`, [hash],
      );
      return rows[0];
    },
    async create(document) {
      await connection.execute(
        `INSERT INTO documents
          (original_filename, storage_key, mime_type, file_size_bytes, sha256, processing_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'processing', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        [document.filename, document.storageKey, document.mimeType, document.size, document.hash],
      );
      const [rows] = await connection.query<(RowDataPacket & { id: string })[]>(
        'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id',
      );
      return rows[0]!.id;
    },
    async finish(id, extraction, error) {
      await connection.execute(
        `UPDATE documents SET processing_status = ?, extracted_text = ?,
         extraction_metadata = ?, error_message = ?, processed_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
        [extraction ? 'ready' : 'failed', extraction?.text ?? null,
          extraction ? JSON.stringify(extraction.metadata) : null, error, id],
      );
      const [rows] = await connection.execute<DocumentRow[]>(`SELECT ${columns} FROM documents WHERE id = ?`, [id]);
      if (!rows[0]) throw new UploadError('DOCUMENT_SAVE_FAILED', 'Document processing could not be saved.', 503);
      return rows[0];
    },
  };
}

export class MysqlDocumentRepository implements DocumentRepository {
  constructor(private readonly pool: Pool | undefined) {}

  async withHashLock<T>(hash: string, action: (store: DocumentStore) => Promise<T>): Promise<T> {
    if (!this.pool) throw new UploadError('DATABASE_UNAVAILABLE', 'Database is not configured.', 503);
    let connection: PoolConnection;
    try { connection = await this.pool.getConnection(); }
    catch { throw new UploadError('DATABASE_UNAVAILABLE', 'Cannot connect to the document database.', 503); }
    let locked = false;
    try {
      // Named locks serialize duplicate checks across API processes without schema changes.
      const [rows] = await connection.execute<(RowDataPacket & { acquired: number | string | null })[]>(
        'SELECT GET_LOCK(?, 2) AS acquired', [hash],
      );
      locked = String(rows[0]?.acquired) === '1';
      if (!locked) throw new UploadError('DOCUMENT_BUSY', 'This document is being processed. Retry shortly.', 503);
      return await action(storeFor(connection));
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError('DOCUMENT_SAVE_FAILED', 'Unable to save document processing results.', 503);
    } finally {
      if (locked) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [hash]); }
        catch { connection.destroy(); }
      }
      connection.release();
    }
  }
}
