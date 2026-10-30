import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { z } from 'zod';
import { isAbsolute } from 'node:path';

// Local source and compiled startup resolve backend/.env against this module.
// Production uses only injected backend environment variables, without file I/O.
let fileEnv: Record<string, string> = {};
try {
  if (process.env.NODE_ENV !== 'production') {
    fileEnv = parse(readFileSync(new URL('../../.env', import.meta.url)));
  }
} catch (error: unknown) {
  if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
    throw new Error('Unable to read backend/.env. Check file permissions.');
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLIENT_ORIGIN: z.url().default('http://localhost:5173'),
  MYSQL_URL: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'mysql:' && url.pathname === '/document_workbench';
  }, 'Must be a mysql:// URL for document_workbench').optional(),
  AI_MODE: z.enum(['mock', 'gemini']).default('mock'),
  MYSQL_SSL_CA: z.string().trim().min(1).optional(),
  GEMINI_API_KEY: z.string().trim().default(''),
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.1-flash-lite'),
  UPLOAD_DIR: z.string().trim().min(1).refine(isAbsolute, 'Must be an absolute storage directory').optional(),
});

// Hosting platforms inject secrets into process.env; never read a local file in production.
// Keep existing file-only credential precedence for local development.
const configuration = process.env.NODE_ENV === 'production' ? process.env
  : { ...process.env, ...fileEnv, MYSQL_URL: fileEnv.MYSQL_URL, GEMINI_API_KEY: fileEnv.GEMINI_API_KEY };
const parsed = schema.safeParse(configuration);
if (!parsed.success) {
  // Report field names without exposing secret values.
  throw new Error(`Invalid environment configuration: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
}
export const env = parsed.data;
