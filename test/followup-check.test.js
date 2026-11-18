import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCheck, onAgentRequest, claim, completeCheckpoint, nextEscalationStep, markStep, MAX_CHECK_ATTEMPTS } from '../src/followup-check.js';

const T0 = new Date('2030-01-01T00:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

function runCheckpoint(check, now, result) {
  const c = claim(check, now);
  assert.equal(c.claimed, true);
  return completeCheckpoint(c.check, result);
}

test('document found at the first checkpoint closes the check', () => {
  const c = runCheckpoint(newCheck(at(0)), at(20), { lookupOk: true, found: true });
  assert.equal(c.status, 'done');
});

test('misses advance through anchored checkpoints and count only accepted re-requests', () => {
  let c = newCheck(at(0));
  c = runCheckpoint(c, at(25), { lookupOk: true, found: false, requestAccepted: true });
  assert.deepEqual([c.stage, c.autoRetries, c.dueAt.toISOString()], [1, 1, at(240).toISOString()]);
  c = runCheckpoint(c, at(300), { lookupOk: true, found: false, requestAccepted: false });
  assert.deepEqual([c.stage, c.autoRetries, c.dueAt.toISOString()], [2, 1, at(480).toISOString()]);
  c = runCheckpoint(c, at(480), { lookupOk: true, found: false, requestAccepted: true });
  assert.equal(c.stage, 3);
  c = runCheckpoint(c, at(720), { lookupOk: true, found: false, requestAccepted: true });
  assert.equal(c.status, 'escalating');
  assert.equal(c.autoRetries, 2, 'the final request is recorded separately');
  assert.equal(c.finalRequestAccepted, true);
});

test('a lookup error is not evidence that the document is missing', () => {
  const c = runCheckpoint(newCheck(at(0)), at(20), { lookupOk: false });
  assert.equal(c.stage, 0);
  assert.equal(c.status, 'pending');
});

test('a checkpoint that keeps failing stops after five attempts instead of looping', () => {
  let c = newCheck(at(0));
  for (let i = 1; i <= MAX_CHECK_ATTEMPTS; i++) {
    const r = claim(c, at(20 + i * 20)); // each previous lease expired (worker crashed)
    assert.equal(r.claimed, true);
    c = r.check;
  }
  const last = claim(c, at(20 + 7 * 20));
  assert.equal(last.claimed, false);
  assert.equal(last.check.status, 'failed');
});

test('an active lease blocks a second worker', () => {
  const first = claim(newCheck(at(0)), at(20));
  assert.equal(claim(first.check, at(25)).claimed, false);
  assert.equal(claim(first.check, at(36)).claimed, true);
});

test('a newer agent request gives at least 20 minutes without consuming a retry', () => {
  let c = newCheck(at(0));
  c = onAgentRequest(c, at(15));
  assert.equal(c.dueAt.toISOString(), at(35).toISOString());
  assert.equal(c.autoRetries, 0);
  assert.equal(c.cycleStartedAt.toISOString(), at(0).toISOString());
});

test('escalation resumes from the first incomplete step and buffers new requests', () => {
  let c = { ...newCheck(at(0)), status: 'escalating', stage: 3 };
  c = markStep(c, nextEscalationStep(c), at(721));
  c = markStep(c, nextEscalationStep(c), at(721));
  // worker crashes here; a resumed run continues at step 3
  assert.equal(nextEscalationStep(c), 'update_case_and_tags');
  c = onAgentRequest(c, at(730));
  assert.equal(c.status, 'escalating', 'a new request does not interrupt escalation');
  c = markStep(c, nextEscalationStep(c), at(740));
  c = markStep(c, nextEscalationStep(c), at(740));
  assert.equal(c.status, 'pending', 'the buffered request starts a fresh cycle');
  assert.equal(c.stage, 0);
});
