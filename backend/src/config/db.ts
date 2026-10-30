import mysql, { type RowDataPacket } from 'mysql2/promise';
import { env } from './env.js';

// Lazy connections let the app run before local MySQL is configured.
export const pool = env.MYSQL_URL
  ? mysql.createPool({
      uri: env.MYSQL_URL,
      connectionLimit: 5,
      waitForConnections: true,
      queueLimit: 10,
      connectTimeout: 5000,
      enableKeepAlive: true,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      timezone: 'Z',
    })
  : undefined;

export type DatabaseHealth =
  | { status: 'ok'; database: 'mysql'; databaseName: 'document_workbench' }
  | { status: 'not_configured' | 'unavailable'; code: string; message: string };

// Never return driver messages: they may include usernames, hosts, or SQL.
const safeErrors: Record<string, string> = {
  ECONNREFUSED: 'MySQL refused the connection. Check that the server is running and the configured port is correct.',
  ENOTFOUND: 'MySQL host could not be resolved. Check the host in backend/.env.',
  EAI_AGAIN: 'MySQL host resolution temporarily failed. Check network connectivity.',
  ETIMEDOUT: 'MySQL connection timed out. Check server availability and network access.',
  EACCES: 'Network permissions blocked the MySQL connection.',
  EPERM: 'Network permissions blocked the MySQL connection.',
  ER_ACCESS_DENIED_ERROR: 'MySQL authentication failed. Check credentials in backend/.env and the database user grants.',
  ER_DBACCESS_DENIED_ERROR: 'The MySQL user does not have access to document_workbench.',
  ER_BAD_DB_ERROR: 'The document_workbench database does not exist. No database or tables were created by this check.',
  PROTOCOL_SEQUENCE_TIMEOUT: 'MySQL health query timed out.',
};

interface HealthRow extends RowDataPacket { connected: number | string; database_name: string | null }

export async function checkDatabaseConnection(): Promise<DatabaseHealth> {
  if (!pool) {
    return { status: 'not_configured', code: 'MYSQL_NOT_CONFIGURED', message: 'Set MYSQL_URL in backend/.env.' };
  }
  try {
    // Read-only connectivity and selected-database check. No schema changes.
    const [rows] = await pool.query<HealthRow[]>({
      sql: 'SELECT 1 AS connected, DATABASE() AS database_name', timeout: 5000,
    });
    // mysql2 can return integer expressions as strings with bigNumberStrings.
    if (String(rows[0]?.connected) !== '1' || rows[0]?.database_name !== 'document_workbench') {
      return { status: 'unavailable', code: 'MYSQL_DATABASE_MISMATCH', message: 'MySQL did not confirm the expected document_workbench database.' };
    }
    return { status: 'ok', database: 'mysql', databaseName: 'document_workbench' };
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : '';
    return {
      status: 'unavailable',
      code: Object.hasOwn(safeErrors, code) ? code : 'MYSQL_CONNECTION_FAILED',
      message: safeErrors[code] ?? 'MySQL connection failed. Check server availability, backend/.env, and pool capacity.',
    };
  }
}
