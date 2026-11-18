-- Durable per-case work queue for long-running AI agent runs.
--
-- Problem it solves: helpdesk webhooks arrive in bursts, are retried by the sender, and
-- can arrive while the agent is still working the same case. Agent runs take minutes and
-- sometimes crash or time out. Without a queue the same case could be worked twice in
-- parallel, events were lost, and failures retried forever.
--
-- Guarantees:
--   * at most one active agent run per case (database ownership, not tags or timing),
--   * every accepted event is stored before it is acknowledged,
--   * duplicate deliveries create no extra work,
--   * bursts of events for one case collapse into one pending follow-up,
--   * three attempts per request, then a visible terminal state,
--   * a late or replaced worker can never complete or overwrite newer work.
-- Every function takes p_now so tests can move time; production passes now().

CREATE TABLE q_control (
  case_id           text PRIMARY KEY,
  active_request    bigint,
  active_token      uuid,          -- random ownership token for the current attempt
  active_execution  text,          -- workflow execution id, set when the worker registers
  claimed_at        timestamptz,
  registered_at     timestamptz
);

CREATE TABLE q_requests (
  id             bigserial PRIMARY KEY,
  case_id        text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('manual','customer','event')),
  priority       int  NOT NULL,                 -- manual 2, customer 1, event 0
  status         text NOT NULL CHECK (status IN
                   ('pending','starting','in_progress','completed','exhausted','needs_review','suppressed','superseded')),
  payload        jsonb NOT NULL,
  delivery_keys  text[] NOT NULL,               -- every delivery id merged into this request
  attempts       int  NOT NULL DEFAULT 0,
  max_attempts   int  NOT NULL DEFAULT 3,
  available_at   timestamptz NOT NULL,
  work_finished_at timestamptz,                 -- durable "the agent finished" receipt
  superseded_by  bigint,
  last_error     text,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX q_one_pending ON q_requests (case_id) WHERE status = 'pending';
CREATE UNIQUE INDEX q_one_active  ON q_requests (case_id) WHERE status IN ('starting','in_progress');
CREATE INDEX q_dispatch ON q_requests (status, available_at, priority DESC, created_at);

CREATE TABLE q_attempts (
  id            bigserial PRIMARY KEY,
  request_id    bigint NOT NULL REFERENCES q_requests(id),
  token         uuid NOT NULL,
  execution_id  text,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  outcome       text
);

-- Gatekeeper: accept one webhook delivery. Called before the HTTP response is sent, so
-- the sender only gets 200 once the event is durably stored.
CREATE FUNCTION q_enqueue(p_case text, p_kind text, p_payload jsonb, p_delivery text, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_ctl     q_control;
  v_pending q_requests;
  v_prio    int := CASE p_kind WHEN 'manual' THEN 2 WHEN 'customer' THEN 1 ELSE 0 END;
  v_id      bigint;
BEGIN
  INSERT INTO q_control (case_id) VALUES (p_case) ON CONFLICT DO NOTHING;
  SELECT * INTO v_ctl FROM q_control WHERE case_id = p_case FOR UPDATE;  -- per-case lock

  -- Sender retries carry the same delivery id: acknowledge, create nothing.
  IF EXISTS (SELECT 1 FROM q_requests WHERE case_id = p_case AND p_delivery = ANY (delivery_keys)) THEN
    RETURN jsonb_build_object('result', 'duplicate');
  END IF;

  -- Someone pressed "run the agent" while it is already running: keep a receipt only.
  IF p_kind = 'manual' AND v_ctl.active_token IS NOT NULL THEN
    INSERT INTO q_requests (case_id, kind, priority, status, payload, delivery_keys, available_at, created_at, updated_at)
    VALUES (p_case, p_kind, v_prio, 'suppressed', p_payload, ARRAY[p_delivery], p_now, p_now, p_now);
    RETURN jsonb_build_object('result', 'suppressed');
  END IF;

  SELECT * INTO v_pending FROM q_requests WHERE case_id = p_case AND status = 'pending';

  IF FOUND AND v_pending.attempts = 0 THEN
    -- Coalesce: the worker reads fresh case data anyway, so N waiting events become one
    -- run with the latest payload, keeping the highest priority seen.
    UPDATE q_requests
    SET payload = p_payload, delivery_keys = delivery_keys || p_delivery,
        priority = greatest(priority, v_prio),
        kind = CASE WHEN v_prio > priority THEN p_kind ELSE kind END,
        updated_at = p_now
    WHERE id = v_pending.id;
    RETURN jsonb_build_object('result', 'coalesced', 'request', v_pending.id);
  END IF;

  INSERT INTO q_requests (case_id, kind, priority, status, payload, delivery_keys, available_at, created_at, updated_at)
  VALUES (p_case, p_kind, v_prio, 'pending', p_payload, ARRAY[p_delivery], p_now, p_now, p_now)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- A failed request is waiting to retry. A genuinely new event supersedes it and gets
    -- its own fresh three-attempt budget; the old row keeps its history.
    INSERT INTO q_requests (case_id, kind, priority, status, payload, delivery_keys, available_at, created_at, updated_at)
    VALUES (p_case, p_kind, greatest(v_prio, v_pending.priority), 'superseded', p_payload, ARRAY[p_delivery], p_now, p_now, p_now)
    RETURNING id INTO v_id;
    UPDATE q_requests SET status = 'superseded', superseded_by = v_id, updated_at = p_now WHERE id = v_pending.id;
    UPDATE q_requests SET status = 'pending' WHERE id = v_id;
    RETURN jsonb_build_object('result', 'superseded_retry', 'request', v_id, 'replaced', v_pending.id);
  END IF;

  -- A customer reply on an idle case starts right away instead of waiting for the batch.
  RETURN jsonb_build_object('result', 'accepted', 'request', v_id,
    'start_now', p_kind = 'customer' AND v_ctl.active_token IS NULL);
END $$;

-- Dispatcher: claim up to p_limit idle cases, manual first, then oldest.
-- SKIP LOCKED lets several dispatchers run without double-claiming.
CREATE FUNCTION q_claim_batch(p_limit int, p_now timestamptz DEFAULT now(), p_case text DEFAULT NULL)
RETURNS TABLE (case_id text, request_id bigint, token uuid, attempt int, payload jsonb)
LANGUAGE plpgsql AS $$
DECLARE r record; v_token uuid;
BEGIN
  FOR r IN
    SELECT q.id, q.case_id FROM q_requests q
    JOIN q_control c ON c.case_id = q.case_id
    WHERE q.status = 'pending' AND q.available_at <= p_now AND c.active_token IS NULL
      AND (p_case IS NULL OR q.case_id = p_case)
    ORDER BY q.priority DESC, q.created_at
    FOR UPDATE OF c SKIP LOCKED
    LIMIT p_limit
  LOOP
    v_token := gen_random_uuid();
    UPDATE q_requests SET status = 'starting', attempts = attempts + 1, updated_at = p_now WHERE id = r.id;
    UPDATE q_control SET active_request = r.id, active_token = v_token, active_execution = NULL,
                         claimed_at = p_now, registered_at = NULL
    WHERE q_control.case_id = r.case_id;
    INSERT INTO q_attempts (request_id, token, started_at) VALUES (r.id, v_token, p_now);
    RETURN QUERY SELECT r.case_id, r.id, v_token, q.attempts, q.payload FROM q_requests q WHERE q.id = r.id;
  END LOOP;
END $$;

-- First node of the agent workflow: prove ownership and record the execution id.
-- A worker whose token was revoked stops here, before touching the case.
CREATE FUNCTION q_register(p_case text, p_token uuid, p_execution text, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE q_control SET active_execution = p_execution, registered_at = p_now
  WHERE case_id = p_case AND active_token = p_token AND registered_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE q_requests SET status = 'in_progress', updated_at = p_now
  WHERE id = (SELECT active_request FROM q_control WHERE case_id = p_case);
  UPDATE q_attempts SET execution_id = p_execution WHERE token = p_token;
  RETURN true;
END $$;

-- Written right after the agent produces a valid result, before final bookkeeping.
-- If the worker dies after this point, recovery completes the request without
-- running the agent again (no duplicate customer messages).
CREATE FUNCTION q_work_finished(p_case text, p_token uuid, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE q_requests SET work_finished_at = p_now, updated_at = p_now
  WHERE id = (SELECT active_request FROM q_control WHERE case_id = p_case AND active_token = p_token);
  RETURN FOUND;
END $$;

-- Internal: end the active attempt. Shared by the worker and by recovery.
CREATE FUNCTION q_end_attempt(p_case text, p_success boolean, p_error text, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_ctl q_control;
  v_req q_requests;
  v_status text;
BEGIN
  SELECT * INTO v_ctl FROM q_control WHERE case_id = p_case FOR UPDATE;
  SELECT * INTO v_req FROM q_requests WHERE id = v_ctl.active_request FOR UPDATE;

  IF p_success THEN
    v_status := 'completed';
  ELSIF EXISTS (SELECT 1 FROM q_requests WHERE case_id = p_case AND status = 'pending') THEN
    -- A newer event is already waiting; it carries fresher data and its own budget.
    v_status := 'superseded';
  ELSIF v_req.attempts >= v_req.max_attempts THEN
    v_status := 'exhausted';                     -- stop, and surface it to a human
  ELSE
    v_status := 'pending';                       -- retry with backoff
  END IF;

  UPDATE q_requests SET
    status = v_status,
    last_error = CASE WHEN p_success THEN last_error ELSE p_error END,
    available_at = CASE WHEN v_status = 'pending' THEN p_now + (v_req.attempts * interval '5 minutes') ELSE available_at END,
    superseded_by = CASE WHEN v_status = 'superseded'
                         THEN (SELECT id FROM q_requests WHERE case_id = p_case AND status = 'pending') END,
    updated_at = p_now
  WHERE id = v_req.id;
  UPDATE q_attempts SET ended_at = p_now, outcome = coalesce(p_error, 'success') WHERE token = v_ctl.active_token;
  UPDATE q_control SET active_request = NULL, active_token = NULL, active_execution = NULL,
                       claimed_at = NULL, registered_at = NULL
  WHERE case_id = p_case;
  RETURN jsonb_build_object('request', v_req.id, 'status', v_status, 'attempts', v_req.attempts);
END $$;

-- Last node of the agent workflow (success) or its error branch (failure).
-- Only the current token may finish; a stale worker gets 'not_owner'.
CREATE FUNCTION q_finish(p_case text, p_token uuid, p_success boolean, p_error text DEFAULT NULL, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM q_control WHERE case_id = p_case AND active_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_owner'); END IF;
  RETURN q_end_attempt(p_case, p_success, p_error, p_now);
END $$;

-- Recovery (scheduled every few minutes). p_executions maps execution id -> state as
-- reported by the workflow engine's API: running | waiting | success | error | canceled | missing.
-- An API outage is passed as NULL and is never treated as proof that an execution is gone.
CREATE FUNCTION q_recover(p_executions jsonb, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  c record;
  v_state text;
  v_req q_requests;
  v_actions jsonb := '[]';
BEGIN
  FOR c IN SELECT * FROM q_control WHERE active_token IS NOT NULL ORDER BY claimed_at FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO v_req FROM q_requests WHERE id = c.active_request;

    IF c.registered_at IS NULL THEN
      -- Claimed but the worker never registered (launch failed, or it is stuck).
      IF c.claimed_at < p_now - interval '20 minutes' THEN
        v_actions := v_actions || (jsonb_build_object('case', c.case_id, 'action', 'revoked_unregistered')
                             || q_end_attempt(c.case_id, false, 'never registered', p_now));
      END IF;
      CONTINUE;
    END IF;

    v_state := p_executions ->> c.active_execution;
    IF p_executions IS NULL OR v_state IS NULL OR v_state IN ('running','waiting') THEN
      CONTINUE;  -- alive, deliberately waiting, or unknown: keep ownership regardless of age
    ELSIF v_state IN ('error','canceled') THEN
      v_actions := v_actions || (jsonb_build_object('case', c.case_id, 'action', 'requeued_after_' || v_state)
                             || q_end_attempt(c.case_id, false, v_state, p_now));
    ELSIF v_state = 'success' THEN
      IF v_req.work_finished_at IS NOT NULL THEN
        v_actions := v_actions || (jsonb_build_object('case', c.case_id, 'action', 'completed_from_receipt')
                             || q_end_attempt(c.case_id, true, NULL, p_now));
      ELSE
        -- Engine says success but the agent never wrote its receipt: don't guess, and
        -- don't silently repeat work that may have already messaged a customer.
        UPDATE q_requests SET status = 'needs_review', updated_at = p_now WHERE id = v_req.id;
        UPDATE q_control SET active_request = NULL, active_token = NULL, active_execution = NULL,
                             claimed_at = NULL, registered_at = NULL WHERE case_id = c.case_id;
        v_actions := v_actions || jsonb_build_object('case', c.case_id, 'action', 'needs_review');
      END IF;
    ELSIF v_state = 'missing' AND c.registered_at < p_now - interval '1 hour' THEN
      -- Execution record pruned or lost. Prefer the receipt; otherwise retry within budget.
      v_actions := v_actions || (jsonb_build_object('case', c.case_id, 'action', 'missing_execution')
                             || q_end_attempt(c.case_id, v_req.work_finished_at IS NOT NULL, 'execution missing', p_now));
    END IF;
  END LOOP;
  RETURN v_actions;
END $$;

-- Read-only monitor used by the manual status workflow.
CREATE VIEW q_status AS
SELECT status, count(*) AS requests, count(DISTINCT case_id) AS cases
FROM q_requests GROUP BY status;
