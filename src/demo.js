// A day in the life of the queue, compressed into a few seconds.
import { openQueue } from './db.js';
import { handleEvent } from './orchestrator.js';

const T0 = new Date('2030-01-01T09:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);
const say = (...a) => console.log(...a);
const q = await openQueue();

say('\n=== Webhooks arrive (the helpdesk retries one of them)');
for (const [c, kind, d, min] of [
  ['CASE-1', 'event', 'w1', 0], ['CASE-1', 'event', 'w1', 0], ['CASE-1', 'event', 'w2', 1],
  ['CASE-2', 'customer', 'w3', 1], ['CASE-3', 'manual', 'w4', 2],
]) say(`  ${c} ${kind.padEnd(8)} delivery ${d} ->`, JSON.stringify(await q.enqueue(c, kind, { at: min }, d, at(min))));

say('\n=== Dispatcher claims a batch (manual first, then oldest)');
const batch = await q.claim(10, at(3));
for (const b of batch) say(`  claimed ${b.case_id} attempt ${b.attempt}`);

say('\n=== Workers register; CASE-1 crashes, CASE-2 finishes, CASE-3 worker never starts');
const tok = Object.fromEntries(batch.map((b) => [b.case_id, b.token]));
await q.register('CASE-1', tok['CASE-1'], 'exec-1', at(3));
await q.register('CASE-2', tok['CASE-2'], 'exec-2', at(3));
await q.workFinished('CASE-2', tok['CASE-2'], at(8));
say('  CASE-2 finish ->', JSON.stringify(await q.finish('CASE-2', tok['CASE-2'], true, null, at(8))));
say('  customer replies on CASE-1 while it is "running" ->', JSON.stringify(await q.enqueue('CASE-1', 'customer', { reply: true }, 'w5', at(10))));

say('\n=== Recovery run (engine reports exec-1 failed)');
for (const a of await q.recover({ 'exec-1': 'error' }, at(30))) say('  ', JSON.stringify(a));

say('\n=== Stale CASE-3 worker wakes up late and tries to act');
say('  register ->', await q.register('CASE-3', tok['CASE-3'], 'exec-late', at(31)));

say('\n=== Next dispatch: CASE-1 runs the newer event with a fresh budget');
for (const b of await q.claim(10, at(33))) say(`  claimed ${b.case_id} attempt ${b.attempt} payload ${JSON.stringify(b.payload)}`);

say('\n=== Orchestrator routing for one event');
const result = await handleEvent({ caseId: 'CASE-1', context: 'Customer sent a new attachment.' }, {
  gatherContext: async () => ({ applicationId: 'APP-9', requesterEmail: 'customer@example.com' }),
  classify: async () => ({ turn_status: 'HANDOFF_REQUIRED', requested_agent: 'tracker', case_path: 'existing_physical', route_directive: 'Attachment update' }),
  specialists: {
    tracker: async () => ({ status: 'HANDOFF_REQUIRED', requested_agent: 'intake' }),
    intake: async () => ({ status: 'COMPLETED' }),
    finalizer: async () => ({ status: 'COMPLETED' }),
  },
  escalate: async () => {},
  passiveReopen: async () => {},
});
say('  ', JSON.stringify(result));
