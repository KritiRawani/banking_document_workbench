import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
const syntheticEnv = {
  ...process.env, NODE_ENV: 'production', PORT: '10000',
  MYSQL_URL: 'mysql://synthetic:synthetic@example.invalid:3306/document_workbench',
  CLIENT_ORIGIN: 'https://synthetic-frontend.vercel.app', AI_MODE: 'gemini',
  GEMINI_API_KEY: 'synthetic-production-key', GEMINI_MODEL: 'synthetic-model',
  UPLOAD_DIR: fileURLToPath(new URL('../uploads-production-test/', import.meta.url)),
};

test('production uses platform environment rather than the local .env for DB, Gemini, CORS, port and storage', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { env } from './backend/src/config/env.ts';
    import { uploadRoot } from './backend/src/documents/storage.ts';
    import { createConfiguredAnalysisService } from './backend/src/analysis/factory.ts';
    assert.equal(env.MYSQL_URL, process.env.MYSQL_URL);
    assert.equal(env.GEMINI_API_KEY, process.env.GEMINI_API_KEY);
    assert.equal(env.GEMINI_MODEL, process.env.GEMINI_MODEL);
    assert.equal(env.AI_MODE, 'gemini');
    assert.equal(env.PORT, 10000);
    assert.equal(env.CLIENT_ORIGIN, process.env.CLIENT_ORIGIN);
    assert.equal(uploadRoot, process.env.UPLOAD_DIR);
    let calls = 0;
    const repository = {
      loadDocuments: async () => [{id:'1',name:'synthetic.txt',text:'Employment type: Salaried',status:'ready',metadata:null}],
      start: async (_docs,_instruction,provider) => { assert.equal(provider.mode,'gemini');return '1'; },
      complete: async () => {}, fail: async () => {}, get: async () => undefined,
    };
    const service = createConfiguredAnalysisService(repository, env, async (_url, init) => {
      calls++;
      assert.equal(init.headers['x-goog-api-key'],process.env.GEMINI_API_KEY);
      return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({facts:[]})}]}}]}));
    });
    const result = await service.analyse({documentIds:['1'],instruction:'Extract employment type'});
    assert.equal(result.mode,'gemini'); assert.equal(calls,1);
    console.log('Production configuration verified');
  `;
  assert.match(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd, env: syntheticEnv, encoding: 'utf8' }), /Production configuration verified/);
});

test('production configuration errors identify fields without exposing credentials', () => {
  const script = `
    try { await import('./backend/src/config/env.ts'); process.exitCode=1; }
    catch(error) {
      if (!error.message.includes('MYSQL_URL') || error.message.includes('synthetic-secret')) process.exitCode=1;
      else console.log('Safe validation verified');
    }
  `;
  assert.match(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd, env: { ...syntheticEnv, MYSQL_URL: 'mysql://synthetic:synthetic-secret@example.invalid/wrong_database' }, encoding: 'utf8' }), /Safe validation verified/);
});
