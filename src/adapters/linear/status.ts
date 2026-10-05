import type { ExecutionEvent } from "../../protocol.js";
import type { WorkUnitTraceability } from "./intake.js";

/**
 * Reflecting execution state and evidence back to Linear.
 *
 * This is one-way: the factory reports; it does not *decide* product state. A
 * status transition is a proposal derived from recorded evidence, and a failed or
 * blocked execution must never be reported as anything resembling success.
 *
 * Every transition is a value with a reason, so the sequence is traceable and a
 * reviewer can see why a Linear issue moved.
 */

export type LinearOutcome = "in_progress" | "blocked" | "failed" | "ready_for_review" | "done";

export interface StatusTransition {
  issueId: string;
  from?: string;
  to: LinearOutcome;
  reason: string;
  /** Evidence the transition is derived from, recorded with it. */
  evidence: {
    workUnitId: string;
    runtimeStatus?: string;
    verificationStatus?: string;
    integrationState?: string;
    prUrl?: string;
  };
}

export interface ReflectInput {
  traceability: WorkUnitTraceability;
  execution: {
    status: "completed" | "failed" | "blocked";
    runtimeStatus?: string;
  };
  verification?: { status: "passed" | "failed" | "blocked" };
  integration?: { state: "ready" | "blocked"; reason?: string };
  prUrl?: string;
}

/**
 * Derives the Linear outcome from recorded evidence.
 *
 * Precedence is deliberate: integration readiness is the strongest signal and
 * requires independent verification to have passed; a runtime that merely exited 0
 * is not evidence of anything. When the Work Unit was blocked or failed, that is
 * reported as-is rather than being flattened into "in progress".
 */
export function deriveOutcome(input: ReflectInput): LinearOutcome {
  const { execution } = input;

  if (execution.status === "blocked") return "blocked";
  if (execution.status === "failed") return "failed";

  // Integration readiness is only ever reached through the gate, which requires
  // independent verification. A completed runtime alone does not get here.
  if (input.integration?.state === "ready" && input.verification?.status === "passed") {
    return input.prUrl === undefined ? "done" : "ready_for_review";
  }

  return "in_progress";
}

export function buildTransition(input: ReflectInput): StatusTransition {
  const outcome = deriveOutcome(input);
  const reason = reasonFor(outcome, input);

  const transition: StatusTransition = {
    issueId: input.traceability.issueId,
    to: outcome,
    reason,
    evidence: {
      workUnitId: input.traceability.issueId,
      ...(input.execution.runtimeStatus === undefined ? {} : { runtimeStatus: input.execution.runtimeStatus }),
      ...(input.verification === undefined ? {} : { verificationStatus: input.verification.status }),
      ...(input.integration === undefined ? {} : { integrationState: input.integration.state }),
      ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
    },
  };
  if (input.traceability.statusType !== undefined) transition.from = input.traceability.statusType;
  return transition;
}

function reasonFor(outcome: LinearOutcome, input: ReflectInput): string {
  switch (outcome) {
    case "blocked":
      return "Work Unit was blocked before or during execution; nothing was dispatched to a runtime";
    case "failed":
      return "execution failed; the Linear issue is not resolved";
    case "done":
      return "integration gate passed on independent verification; no pull request was opened";
    case "ready_for_review":
      return "integration gate passed on independent verification and a pull request is open for review";
    case "in_progress":
      return input.verification === undefined
        ? "execution completed but has no independent verification yet; runtime completion is not correctness"
        : "independent verification has not passed; not integration-ready";
  }
}

/**
 * Status transitions are recorded as **factory** events. They are factory
 * decisions about what to report, not Linear's own state, and must never be
 * confused with runtime output.
 */
export function transitionEvent(transition: StatusTransition, timestamp: string): ExecutionEvent {
  return {
    id: `linear-${transition.issueId}-${transition.to}`,
    workUnitId: transition.evidence.workUnitId,
    type: "integration.status_proposed",
    timestamp,
    payload: { to: transition.to, reason: transition.reason, evidence: transition.evidence },
  };
}

/**
 * The factory never marks work done on its own authority. `done` requires an
 * explicit human acknowledgement, so a machine reading this module cannot complete
 * an issue unattended.
 */
export function requiresHumanAcknowledgement(outcome: LinearOutcome): boolean {
  return outcome === "done";
}
