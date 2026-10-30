import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('Gemini credentials come from backend/.env even when the shell supplies a different key', () => {
  const script = `
    import { readFileSync } from 'node:fs';
    import { parse } from 'dotenv';
    import { env } from './backend/src/config/env.ts';
    let file = {};
    try { file = parse(readFileSync('backend/.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to read test configuration'); }
    if (env.GEMINI_API_KEY !== (file.GEMINI_API_KEY ?? '').trim()) throw new Error('Gemini key did not come from backend/.env');
    console.log('Backend file-only credential loading verified');
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, GEMINI_API_KEY: 'synthetic-shell-key-must-not-be-used' }, encoding: 'utf8',
  });
  assert.match(output, /file-only credential loading verified/);
});
