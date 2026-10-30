import { app } from './app.js';
import { env } from './config/env.js';
import { pool, checkDatabaseConnection } from './config/db.js';

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`Backend running at http://localhost:${env.PORT}`);
  console.log(env.AI_MODE === 'gemini'
    ? `Analysis provider configured: Gemini (${env.GEMINI_MODEL}); rule-based fallback enabled`
    : 'Analysis provider configured: mock / rule-based');
  void checkDatabaseConnection().then(health => {
    if (health.status === 'ok') console.log('MySQL connected: document_workbench');
    else console.error(`MySQL check failed [${health.code}]: ${health.message}`);
  });
});
server.on('error', () => { console.error('Unable to start backend. Check PORT availability.'); process.exit(1); });

function shutdown() {
  server.close(() => { void (pool?.end() ?? Promise.resolve()).finally(() => process.exit(0)); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
