import { checkDatabaseConnection, pool } from '../config/db.js';

try {
  const health = await checkDatabaseConnection();
  if (health.status === 'ok') {
    console.log('PASS: MySQL query succeeded and selected database is document_workbench.');
  } else {
    console.error(`FAIL [${health.code}]: ${health.message}`);
    process.exitCode = 1;
  }
} finally {
  await pool?.end();
}
