// Orchestrator + specialist sub-agents.
//
// The single production agent carried one very large prompt and a broad toolset through
// the whole case lifecycle on every run. The orchestrator design splits that:
//
//   1. The workflow (not the model) gathers context: case history, application record,
//      case status. No tool calls needed for that.
//   2. A tool-less, cheap routing model classifies the event into a strict contract.
//   3. The workflow handles escalation / passive reopen itself, or calls exactly ONE
//      specialist with a stage-specific prompt and only that stage's tools.
//   4. A specialist may say "wrong specialist" once; one reroute is allowed, never a loop.
//
// Expected benefit: less input context per run (cheaper, faster) and better focus,
// because each specialist only sees the rules and tools for its stages.

export const SPECIALISTS = {
  intake: { stages: 'intake, verification, document preparation, delivery' },
  tracker: { stages: 'fulfilment monitoring, delivery follow-up, exceptions' },
  finalizer: { stages: 'post-delivery status monitoring, closure' },
};

export const TURN_STATUS = ['HANDOFF_REQUIRED', 'ESCALATION_REQUIRED', 'PASSIVE_REOPEN'];
export const CASE_PATHS = ['new_physical', 'new_digital', 'existing_physical', 'existing_digital'];

// Output-parser equivalent: reject anything outside the contract instead of guessing.
export function validateRoute(out) {
  const errors = [];
  if (!out || typeof out !== 'object') return ['not an object'];
  if (!TURN_STATUS.includes(out.turn_status)) errors.push('turn_status');
  if (out.turn_status === 'HANDOFF_REQUIRED') {
    if (!(out.requested_agent in SPECIALISTS)) errors.push('requested_agent');
    if (!CASE_PATHS.includes(out.case_path)) errors.push('case_path');
    if (typeof out.route_directive !== 'string' || out.route_directive.length > 500) errors.push('route_directive');
  }
  return errors;
}

// The seven fields every specialist receives, assembled by the workflow.
export function specialistInput(event, context, route) {
  return {
    task_description: 'Move this case forward according to your stage instructions.',
    event_context: event.context,
    case_id: event.caseId,
    application_id: context.applicationId,
    requester_email: context.requesterEmail,
    case_path: route.case_path,
    route_directive: route.route_directive,
  };
}

// deps: { gatherContext, classify, specialists: {name: fn}, escalate, passiveReopen }
export async function handleEvent(event, deps, { maxReroutes = 1 } = {}) {
  const trace = [];
  const context = await deps.gatherContext(event);
  const route = await deps.classify({ event, context });
  const errors = validateRoute(route);
  if (errors.length) {
    trace.push({ step: 'invalid_route', errors });
    await deps.escalate(event, `orchestrator output failed validation: ${errors.join(', ')}`);
    return { outcome: 'escalated', trace };
  }
  trace.push({ step: 'routed', turn_status: route.turn_status, agent: route.requested_agent ?? null });

  if (route.turn_status === 'ESCALATION_REQUIRED') {
    await deps.escalate(event, route.route_directive ?? 'orchestrator requested escalation');
    return { outcome: 'escalated', trace };
  }
  if (route.turn_status === 'PASSIVE_REOPEN') {
    await deps.passiveReopen(event);
    return { outcome: 'returned_to_pending', trace };
  }

  let agent = route.requested_agent;
  for (let reroutes = 0; ; reroutes++) {
    const result = await deps.specialists[agent](specialistInput(event, context, route));
    trace.push({ step: 'specialist', agent, status: result.status });
    if (result.status !== 'HANDOFF_REQUIRED') return { outcome: result.status, agent, trace };
    if (reroutes >= maxReroutes || !(result.requested_agent in SPECIALISTS) || result.requested_agent === agent) {
      await deps.escalate(event, `misroute not resolved after ${reroutes + 1} specialist run(s)`);
      trace.push({ step: 'reroute_limit' });
      return { outcome: 'escalated', trace };
    }
    agent = result.requested_agent;
  }
}
