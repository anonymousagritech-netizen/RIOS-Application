/**
 * Workflow definition interpreter (brief §10.3, §28.3).
 *
 * A workflow is a state machine described entirely as metadata (a config
 * document of `kind: 'workflow'`): a set of named states and the transitions
 * between them. This module is the *pure* interpreter - it validates a
 * definition, answers "what transitions are legal from here", and computes the
 * next state for an event. It performs no I/O: the server loads the definition
 * from `config_document`, drives `workflow_instance` rows through it, and
 * persists the result. Keeping the engine pure makes the state-machine rules
 * provable in unit tests, exactly like the money math.
 */

export interface WorkflowTransition {
  /** The event/action that fires the transition, e.g. 'submit', 'approve'. */
  event: string;
  /** State the instance must currently be in. */
  from: string;
  /** State the instance moves to. */
  to: string;
  /** Optional permission the actor must hold for this transition. */
  permission?: string;
  /** Optional human label for the action button. */
  label?: string;
}

export interface WorkflowDefinition {
  /** Stable key, e.g. 'treaty.lifecycle'. */
  key: string;
  /** Display name. */
  name?: string;
  /** The starting state for a new instance. */
  initial: string;
  /** All valid states. */
  states: string[];
  /** Terminal states (no outgoing transitions expected). */
  finalStates?: string[];
  transitions: WorkflowTransition[];
}

export interface ValidationIssue {
  code: string;
  message: string;
}

/** Structural validation of a workflow definition. Returns all issues found. */
export function validateWorkflow(def: WorkflowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const states = new Set(def.states ?? []);

  if (!def.key) issues.push({ code: 'no_key', message: 'Workflow needs a key.' });
  if (!def.states || def.states.length === 0) {
    issues.push({ code: 'no_states', message: 'Workflow must define at least one state.' });
  }
  if (new Set(def.states).size !== (def.states ?? []).length) {
    issues.push({ code: 'duplicate_state', message: 'State names must be unique.' });
  }
  if (!def.initial || !states.has(def.initial)) {
    issues.push({ code: 'bad_initial', message: 'initial must be one of the defined states.' });
  }
  for (const s of def.finalStates ?? []) {
    if (!states.has(s)) issues.push({ code: 'bad_final', message: `Final state "${s}" is not a defined state.` });
  }
  for (const [i, t] of (def.transitions ?? []).entries()) {
    if (!t.event) issues.push({ code: 'no_event', message: `Transition ${i} has no event.` });
    if (!states.has(t.from)) issues.push({ code: 'bad_from', message: `Transition ${i}: "${t.from}" is not a defined state.` });
    if (!states.has(t.to)) issues.push({ code: 'bad_to', message: `Transition ${i}: "${t.to}" is not a defined state.` });
  }
  // An orphaned state - not the initial state, with neither an incoming nor an
  // outgoing transition - is unreachable and unusable. (A terminal state such as
  // ACTIVE legitimately has no *outgoing* transition, so we require *both* to be
  // absent before flagging.)
  const hasOut = new Set((def.transitions ?? []).map((t) => t.from));
  const hasIn = new Set((def.transitions ?? []).map((t) => t.to));
  for (const s of states) {
    if (s !== def.initial && !hasIn.has(s) && !hasOut.has(s)) {
      issues.push({ code: 'orphan_state', message: `State "${s}" is unreachable (no incoming or outgoing transition).` });
    }
  }
  return issues;
}

/** Is the definition structurally valid (no issues)? */
export function isValidWorkflow(def: WorkflowDefinition): boolean {
  return validateWorkflow(def).length === 0;
}

/** The transitions legally available from a given state. */
export function availableTransitions(def: WorkflowDefinition, state: string): WorkflowTransition[] {
  return (def.transitions ?? []).filter((t) => t.from === state);
}

export interface TransitionResult {
  ok: boolean;
  state: string;
  /** Set when ok is false. */
  reason?: string;
  /** The transition that fired, when ok. */
  transition?: WorkflowTransition;
}

/**
 * Apply an event to the current state. Pure: returns the next state or a reason
 * the event was rejected. When `permissions` is supplied, a transition that
 * declares a `permission` is only allowed if the actor holds it (or 'admin:manage').
 */
export function applyEvent(
  def: WorkflowDefinition,
  currentState: string,
  event: string,
  permissions?: string[],
): TransitionResult {
  if (!def.states?.includes(currentState)) {
    return { ok: false, state: currentState, reason: `"${currentState}" is not a state of ${def.key}.` };
  }
  const candidates = (def.transitions ?? []).filter((t) => t.from === currentState && t.event === event);
  if (candidates.length === 0) {
    return { ok: false, state: currentState, reason: `No "${event}" transition from "${currentState}".` };
  }
  const t = candidates[0]!;
  if (t.permission && permissions && !permissions.includes(t.permission) && !permissions.includes('admin:manage')) {
    return { ok: false, state: currentState, reason: `Missing permission "${t.permission}".` };
  }
  return { ok: true, state: t.to, transition: t };
}

/** Is a state terminal (declared final, or has no outgoing transitions)? */
export function isFinalState(def: WorkflowDefinition, state: string): boolean {
  if ((def.finalStates ?? []).includes(state)) return true;
  return availableTransitions(def, state).length === 0;
}
