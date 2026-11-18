// Follow-up check for an asynchronous external job (in production: a document PDF that a
// third-party generator produced some time after the agent requested it).
//
// "Request accepted" never meant "document created". Instead of the agent waiting, the
// request registers a check row, and a scheduler (every 5 minutes, up to 10 rows) runs
// this state machine.
//
//   checkpoints  ~20 min, 4 h, 8 h, 12 h after the first accepted request
//   at each of the first three misses: send one automatic re-request (stage advances even
//     if the re-request is rejected; only accepted re-requests count as retries)
//   at the 12 h miss: one final request, then escalate in four separately-marked steps
//   a failed or crashed check run is retried, but at most 5 attempts per checkpoint
//   a newer agent request during a cycle refreshes the reference time (no extra retry)
//
// The production version was SQL in PostgreSQL plus n8n workflows; this is the same logic
// as a pure function so it can be read and tested in isolation.

export const CHECKPOINTS_MIN = [20, 240, 480, 720];
export const MAX_CHECK_ATTEMPTS = 5;
export const LEASE_MIN = 15;
export const ESCALATION_STEPS = ['mark_record_escalated', 'notify_partner', 'update_case_and_tags', 'alert_owner'];

const addMin = (t, m) => new Date(t.getTime() + m * 60_000);

export function newCheck(now) {
  return {
    status: 'pending', // pending | done | escalating | escalated | failed
    cycleStartedAt: now,
    referenceAt: now,
    stage: 0,
    autoRetries: 0,
    checkAttempts: 0,
    dueAt: addMin(now, CHECKPOINTS_MIN[0]),
    leaseUntil: null,
    finalRequestAccepted: null,
    steps: {},
    bufferedRequestAt: null,
  };
}

// The agent asked for the document (again).
export function onAgentRequest(check, now) {
  if (!check || check.status === 'done' || check.status === 'escalated') return newCheck(now);
  if (check.status === 'escalating' || check.status === 'failed') {
    // Never interrupt a half-finished escalation; start fresh once it completes.
    return { ...check, bufferedRequestAt: now };
  }
  // Pending cycle: keep stage and cycle start, but give the new request at least 20 min.
  const minDue = addMin(now, CHECKPOINTS_MIN[0]);
  return { ...check, referenceAt: now, dueAt: check.dueAt < minDue ? minDue : check.dueAt };
}

// Scheduler claim. Counting the attempt at claim time means crashes count too.
export function claim(check, now) {
  const due = check.status === 'pending' || check.status === 'escalating';
  const leaseFree = !check.leaseUntil || check.leaseUntil <= now;
  if (!due || check.dueAt > now || !leaseFree) return { claimed: false, check };
  if (check.checkAttempts >= MAX_CHECK_ATTEMPTS) {
    return { claimed: false, check: { ...check, status: 'failed', leaseUntil: null } };
  }
  return {
    claimed: true,
    check: { ...check, checkAttempts: check.checkAttempts + 1, leaseUntil: addMin(now, LEASE_MIN) },
  };
}

// Worker result for a claimed checkpoint.
//   lookupOk: false when the document store errored (an error is not evidence of absence)
//   found: a document updated after referenceAt exists
//   requestAccepted: whether the re-request (if one was sent) was accepted
export function completeCheckpoint(check, { lookupOk, found, requestAccepted }) {
  if (!lookupOk) return { ...check, leaseUntil: null }; // retry later within the attempt budget
  if (found) return { ...check, status: 'done', leaseUntil: null, checkAttempts: 0 };

  if (check.stage < CHECKPOINTS_MIN.length - 1) {
    const stage = check.stage + 1;
    return {
      ...check,
      stage,
      autoRetries: check.autoRetries + (requestAccepted ? 1 : 0),
      dueAt: addMin(check.cycleStartedAt, CHECKPOINTS_MIN[stage]), // anchored to the cycle, not to "now"
      leaseUntil: null,
      checkAttempts: 0,
    };
  }
  // Final checkpoint missed: one last request is recorded separately, then escalate.
  return { ...check, status: 'escalating', finalRequestAccepted: !!requestAccepted, leaseUntil: null, checkAttempts: 0 };
}

// Each escalation side effect has its own marker so a resumed run skips what is done.
export function nextEscalationStep(check) {
  return ESCALATION_STEPS.find((s) => !check.steps[s]) ?? null;
}

export function markStep(check, step, now) {
  const steps = { ...check.steps, [step]: true };
  const finished = ESCALATION_STEPS.every((s) => steps[s]);
  if (!finished) return { ...check, steps };
  const done = { ...check, steps, status: 'escalated', leaseUntil: null };
  return done.bufferedRequestAt ? newCheck(done.bufferedRequestAt > now ? done.bufferedRequestAt : now) : done;
}
