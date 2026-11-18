import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleEvent, validateRoute } from '../src/orchestrator.js';

function deps(route, specialistResults = {}) {
  const calls = { escalate: [], reopen: 0, specialists: [] };
  const specialist = (name) => async (input) => {
    calls.specialists.push({ name, input });
    const queue = specialistResults[name] ?? [{ status: 'COMPLETED' }];
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return {
    calls,
    gatherContext: async () => ({ applicationId: 'APP-1', requesterEmail: 'customer@example.com' }),
    classify: async () => route,
    specialists: { intake: specialist('intake'), tracker: specialist('tracker'), finalizer: specialist('finalizer') },
    escalate: async (_e, reason) => calls.escalate.push(reason),
    passiveReopen: async () => { calls.reopen++; },
  };
}

const event = { caseId: 'C1', context: 'Customer replied with a new attachment.' };
const handoff = (agent) => ({ turn_status: 'HANDOFF_REQUIRED', requested_agent: agent, case_path: 'existing_physical', route_directive: 'Check the new attachment.' });

test('routes to exactly one specialist with the seven-field contract', async () => {
  const d = deps(handoff('intake'));
  const r = await handleEvent(event, d);
  assert.equal(r.outcome, 'COMPLETED');
  assert.equal(d.calls.specialists.length, 1);
  assert.deepEqual(Object.keys(d.calls.specialists[0].input).sort(), [
    'application_id', 'case_id', 'case_path', 'event_context', 'requester_email', 'route_directive', 'task_description',
  ]);
});

test('escalation and passive reopen are handled by the workflow, not a specialist', async () => {
  const e = deps({ turn_status: 'ESCALATION_REQUIRED', route_directive: 'refund request' });
  assert.equal((await handleEvent(event, e)).outcome, 'escalated');
  assert.equal(e.calls.specialists.length, 0);
  const p = deps({ turn_status: 'PASSIVE_REOPEN' });
  assert.equal((await handleEvent(event, p)).outcome, 'returned_to_pending');
  assert.equal(p.calls.reopen, 1);
});

test('one misroute is corrected by a single reroute', async () => {
  const d = deps(handoff('intake'), { intake: [{ status: 'HANDOFF_REQUIRED', requested_agent: 'tracker' }] });
  const r = await handleEvent(event, d);
  assert.equal(r.outcome, 'COMPLETED');
  assert.deepEqual(d.calls.specialists.map((s) => s.name), ['intake', 'tracker']);
});

test('ping-pong between specialists stops after one reroute and escalates', async () => {
  const d = deps(handoff('intake'), {
    intake: [{ status: 'HANDOFF_REQUIRED', requested_agent: 'tracker' }],
    tracker: [{ status: 'HANDOFF_REQUIRED', requested_agent: 'intake' }],
  });
  const r = await handleEvent(event, d);
  assert.equal(r.outcome, 'escalated');
  assert.equal(d.calls.specialists.length, 2);
});

test('malformed routing output is escalated, never guessed', async () => {
  assert.deepEqual(validateRoute({ turn_status: 'HANDOFF_REQUIRED', requested_agent: 'nobody', case_path: 'x' }),
    ['requested_agent', 'case_path', 'route_directive']);
  const d = deps({ turn_status: 'DO_SOMETHING' });
  assert.equal((await handleEvent(event, d)).outcome, 'escalated');
  assert.equal(d.calls.specialists.length, 0);
});
