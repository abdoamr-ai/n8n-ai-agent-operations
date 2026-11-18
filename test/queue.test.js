import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openQueue } from '../src/db.js';

const T0 = new Date('2030-01-01T09:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

test('duplicate deliveries create no extra work', async () => {
  const q = await openQueue();
  assert.equal((await q.enqueue('C1', 'event', { v: 1 }, 'd1', at(0))).result, 'accepted');
  assert.equal((await q.enqueue('C1', 'event', { v: 1 }, 'd1', at(1))).result, 'duplicate');
  assert.equal((await q.requests('C1')).length, 1);
});

test('a burst of events for one case collapses into one run with the latest payload', async () => {
  const q = await openQueue();
  await q.enqueue('C1', 'event', { v: 1 }, 'd1', at(0));
  await q.enqueue('C1', 'event', { v: 2 }, 'd2', at(1));
  const r = await q.enqueue('C1', 'manual', { v: 3 }, 'd3', at(2));
  assert.equal(r.result, 'coalesced');
  const [req] = await q.requests('C1');
  assert.deepEqual(req.payload, { v: 3 });
  assert.deepEqual(req.delivery_keys, ['d1', 'd2', 'd3']);
  assert.equal(req.kind, 'manual', 'keeps the highest priority');
});

test('at most one active run per case; follow-up waits as a single pending request', async () => {
  const q = await openQueue();
  await q.enqueue('C1', 'event', {}, 'd1', at(0));
  const [run] = await q.claim(10, at(1));
  assert.ok(await q.register('C1', run.token, 'exec-1', at(1)));
  await q.enqueue('C1', 'customer', { reply: 1 }, 'd2', at(2));
  await q.enqueue('C1', 'customer', { reply: 2 }, 'd3', at(3));
  assert.equal((await q.claim(10, at(4))).length, 0, 'case is busy');
  assert.equal((await q.enqueue('C1', 'manual', {}, 'd4', at(4))).result, 'suppressed');
  await q.workFinished('C1', run.token, at(5));
  assert.equal((await q.finish('C1', run.token, true, null, at(5))).status, 'completed');
  const [next] = await q.claim(10, at(6));
  assert.deepEqual(next.payload, { reply: 2 });
});

test('customer reply on an idle case is flagged to start immediately', async () => {
  const q = await openQueue();
  assert.equal((await q.enqueue('C1', 'customer', {}, 'd1', at(0))).start_now, true);
});

test('dispatcher takes manual requests first, then oldest, within the batch limit', async () => {
  const q = await openQueue();
  await q.enqueue('A', 'event', {}, 'a', at(0));
  await q.enqueue('B', 'event', {}, 'b', at(1));
  await q.enqueue('C', 'manual', {}, 'c', at(2));
  const batch = await q.claim(2, at(3));
  assert.deepEqual(batch.map((b) => b.case_id), ['C', 'A']);
});

test('failures retry with backoff, then stop after three attempts', async () => {
  const q = await openQueue();
  await q.enqueue('C1', 'event', {}, 'd1', at(0));
  let t = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [run] = await q.claim(10, at(t += 60));
    assert.equal(run.attempt, attempt);
    await q.register('C1', run.token, `exec-${attempt}`, at(t));
    const r = await q.finish('C1', run.token, false, 'tool timeout', at(t));
    assert.equal(r.status, attempt < 3 ? 'pending' : 'exhausted');
  }
  assert.equal((await q.claim(10, at(t + 600))).length, 0);
});

test('a new event supersedes a waiting retry and gets a fresh budget', async () => {
  const q = await openQueue();
  await q.enqueue('C1', 'event', {}, 'd1', at(0));
  const [run] = await q.claim(10, at(1));
  await q.register('C1', run.token, 'e1', at(1));
  await q.finish('C1', run.token, false, 'boom', at(2));
  const r = await q.enqueue('C1', 'customer', { fresh: true }, 'd2', at(3));
  assert.equal(r.result, 'superseded_retry');
  const reqs = await q.requests('C1');
  assert.equal(reqs[0].status, 'superseded');
  assert.equal(reqs[0].superseded_by, reqs[1].id);
  const [next] = await q.claim(10, at(4));
  assert.equal(next.attempt, 1);
});

test('a stale worker cannot register or finish after its token is revoked', async () => {
  const q = await openQueue();
  await q.enqueue('C1', 'event', {}, 'd1', at(0));
  const [stale] = await q.claim(10, at(0));
  const rec = await q.recover({}, at(25));
  assert.equal(rec[0].action, 'revoked_unregistered');
  assert.equal(await q.register('C1', stale.token, 'late', at(26)), false);
  const [fresh] = await q.claim(10, at(60));
  assert.equal((await q.finish('C1', stale.token, true, null, at(61))).status, 'not_owner');
  assert.ok(await q.register('C1', fresh.token, 'e2', at(61)));
});

test('recovery: crash requeues, receipt completes, unexplained success needs review', async () => {
  const q = await openQueue();
  for (const c of ['crash', 'receipt', 'mystery', 'alive']) await q.enqueue(c, 'event', {}, c, at(0));
  const runs = await q.claim(10, at(1));
  for (const r of runs) await q.register(r.case_id, r.token, `exec-${r.case_id}`, at(1));
  await q.workFinished('receipt', runs.find((r) => r.case_id === 'receipt').token, at(2));

  const actions = await q.recover({
    'exec-crash': 'error', 'exec-receipt': 'success', 'exec-mystery': 'success', 'exec-alive': 'running',
  }, at(90));
  const byCase = Object.fromEntries(actions.map((a) => [a.case, a]));
  assert.equal(byCase.crash.status, 'pending');
  assert.equal(byCase.receipt.status, 'completed');
  assert.equal(byCase.mystery.action, 'needs_review');
  assert.equal(byCase.alive, undefined, 'a running execution keeps ownership regardless of age');
});

test('an engine API outage is never treated as a missing execution', async () => {
  const q = await openQueue();
  await q.enqueue('C1', 'event', {}, 'd1', at(0));
  const [run] = await q.claim(10, at(0));
  await q.register('C1', run.token, 'e1', at(0));
  assert.deepEqual(await q.recover(null, at(500)), []);
  const actions = await q.recover({ e1: 'missing' }, at(30));
  assert.deepEqual(actions, [], 'waits an hour before trusting "missing"');
  assert.equal((await q.recover({ e1: 'missing' }, at(61)))[0].status, 'pending');
});
