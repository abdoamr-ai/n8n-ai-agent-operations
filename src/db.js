// In-memory PostgreSQL (PGlite) with the queue schema loaded. Production used hosted
// PostgreSQL called from n8n Postgres nodes with bound parameters; the SQL is identical.
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export async function openQueue() {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../db/queue.sql', import.meta.url), 'utf8'));
  const call = async (sql, params) => (await db.query(sql, params)).rows;
  return {
    db,
    enqueue: async (caseId, kind, payload, delivery, now) =>
      (await call('SELECT q_enqueue($1,$2,$3,$4,$5) AS r', [caseId, kind, JSON.stringify(payload), delivery, now]))[0].r,
    claim: (limit, now, caseId = null) => call('SELECT * FROM q_claim_batch($1,$2,$3)', [limit, now, caseId]),
    register: async (caseId, token, execution, now) =>
      (await call('SELECT q_register($1,$2,$3,$4) AS ok', [caseId, token, execution, now]))[0].ok,
    workFinished: async (caseId, token, now) =>
      (await call('SELECT q_work_finished($1,$2,$3) AS ok', [caseId, token, now]))[0].ok,
    finish: async (caseId, token, success, error, now) =>
      (await call('SELECT q_finish($1,$2,$3,$4,$5) AS r', [caseId, token, success, error, now]))[0].r,
    recover: async (executions, now) =>
      (await call('SELECT q_recover($1,$2) AS r', [executions === null ? null : JSON.stringify(executions), now]))[0].r,
    requests: (caseId) =>
      call('SELECT id, kind, status, attempts, delivery_keys, payload, superseded_by FROM q_requests WHERE case_id = $1 ORDER BY id', [caseId]),
  };
}
