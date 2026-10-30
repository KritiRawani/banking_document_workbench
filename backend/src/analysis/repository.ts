import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { AnalysisError, type AnalysisDocument, type AnalysisProvider, type AnalysisRepository, type AnalysisResult, type Finding } from './types.js';

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export class MysqlAnalysisRepository implements AnalysisRepository {
  constructor(private readonly pool: Pool | undefined) {}

  private async query<T>(action: (connection: PoolConnection) => Promise<T>, transaction = false): Promise<T> {
    if (!this.pool) throw new AnalysisError('DATABASE_UNAVAILABLE', 'Database is not configured.', 503);
    let connection: PoolConnection;
    try { connection = await this.pool.getConnection(); }
    catch { throw new AnalysisError('DATABASE_UNAVAILABLE', 'Cannot connect to the analysis database.', 503); }
    try {
      if (transaction) await connection.beginTransaction();
      const result = await action(connection);
      if (transaction) await connection.commit();
      return result;
    } catch (error) {
      if (transaction) await connection.rollback().catch(() => undefined);
      if (error instanceof AnalysisError) throw error;
      throw new AnalysisError('ANALYSIS_DATABASE_ERROR', 'Unable to read or save analysis data.', 503);
    } finally { connection.release(); }
  }

  async loadDocuments(ids: string[]): Promise<AnalysisDocument[]> {
    return this.query(async connection => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) AS id, original_filename, extracted_text, extraction_metadata, processing_status
         FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
      );
      return rows.map(row => ({ id: String(row.id), name: String(row.original_filename), text: row.extracted_text ?? '',
        metadata: json(row.extraction_metadata), status: String(row.processing_status) }));
    });
  }

  async start(documents: AnalysisDocument[], instruction: string, provider: AnalysisProvider): Promise<string> {
    return this.query(async connection => {
      await connection.execute(
        `INSERT INTO analysis_sessions (instruction, status, ai_mode, ai_model, prompt_version, created_at, updated_at)
         VALUES (?, 'processing', ?, ?, 'grounded-v1', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        [instruction, provider.mode, provider.model],
      );
      const [rows] = await connection.query<RowDataPacket[]>('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
      const id = String(rows[0]!.id);
      for (const doc of documents) {
        await connection.execute('INSERT INTO analysis_documents (analysis_session_id, document_id, created_at) VALUES (?, ?, UTC_TIMESTAMP(3))', [id, doc.id]);
      }
      return id;
    }, true);
  }

  async complete(result: AnalysisResult): Promise<void> {
    await this.query(async connection => {
      for (const [order, finding] of result.findings.entries()) {
        for (const documentId of new Set(finding.sources.map(source => source.documentId))) {
          const evidence = finding.sources.filter(source => source.documentId === documentId && source.quote !== null)
            .map(source => ({ quote: source.quote, char_start: source.charStart, char_end: source.charEnd, ...(source.page ? { page: source.page } : {}) }));
          await connection.execute(
            `INSERT INTO findings (analysis_session_id, source_document_id, finding_group_id, finding_type, content_kind,
             title, description, structured_value, source_evidence, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
            [result.id, documentId, finding.id, finding.type, finding.contentKind, finding.title, finding.description,
              JSON.stringify({ severity: finding.severity, values: finding.values, order }), JSON.stringify(evidence)],
          );
        }
      }
      const { findings: _findings, ...envelope } = result;
      // TEXT column stores a versioned JSON envelope for summary and run context;
      // findings/evidence remain in their existing relational tables.
      await connection.execute(
        `UPDATE analysis_sessions SET status = 'completed', summary = ?, error_message = NULL,
         completed_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
        [JSON.stringify(envelope), result.id],
      );
    }, true);
  }

  async fail(id: string, message: string): Promise<void> {
    await this.query(async connection => {
      await connection.execute(
        `UPDATE analysis_sessions SET status = 'failed', error_message = ?, completed_at = UTC_TIMESTAMP(3),
         updated_at = UTC_TIMESTAMP(3) WHERE id = ?`, [message, id],
      );
    });
  }

  async get(id: string): Promise<AnalysisResult | undefined> {
    return this.query(async connection => {
      const [sessions] = await connection.execute<RowDataPacket[]>(
        "SELECT summary FROM analysis_sessions WHERE id = ? AND status = 'completed' AND prompt_version = 'grounded-v1'", [id],
      );
      if (!sessions[0]) return undefined;
      const envelope = json(sessions[0].summary) as Omit<AnalysisResult, 'findings'>;
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT f.*, CAST(f.source_document_id AS CHAR) AS document_id, d.original_filename
         FROM findings f JOIN documents d ON d.id = f.source_document_id
         WHERE f.analysis_session_id = ? ORDER BY f.id`, [id],
      );
      const grouped = new Map<string, { order: number; finding: Finding }>();
      for (const row of rows) {
        const value = json(row.structured_value) as { severity: Finding['severity']; values: Finding['values']; order: number };
        const key = String(row.finding_group_id);
        if (!grouped.has(key)) grouped.set(key, { order: value.order, finding: {
          id: key, type: row.finding_type, contentKind: row.content_kind,
          severity: value.severity, title: row.title, description: row.description, values: value.values, sources: [],
        } });
        const evidence = json(row.source_evidence) as { quote: string; char_start: number; char_end: number; page?: number }[];
        const sources = grouped.get(key)!.finding.sources;
        if (!evidence.length) sources.push({ documentId: String(row.document_id), documentName: row.original_filename, quote: null, charStart: null, charEnd: null });
        for (const item of evidence) sources.push({ documentId: String(row.document_id), documentName: row.original_filename,
          quote: item.quote, charStart: item.char_start, charEnd: item.char_end, ...(item.page ? { page: item.page } : {}) });
      }
      return { ...envelope, findings: [...grouped.values()].sort((a, b) => a.order - b.order).map(item => item.finding) };
    });
  }
}
