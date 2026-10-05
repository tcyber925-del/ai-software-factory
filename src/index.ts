export * from "./protocol.js";
export {FakeRuntime} from "./fake-runtime.js";
export {validateAgainstSchema, isRecord} from "./kernel/json-schema.js";
export type {JsonSchema, JsonValue, ValidationIssue} from "./kernel/json-schema.js";
export {validateWorkUnit, workUnitToWireForm, selectRuntime} from "./kernel/work-unit.js";
export type {LabelledRuntime, RuntimeCandidate, RuntimeSelection, WorkUnitValidation} from "./kernel/work-unit.js";
export {executeWorkUnit} from "./kernel/execution.js";
export type {ExecuteWorkUnitOptions, ExecutionFailure, ExecutionRecord, ExecutionStatus} from "./kernel/execution.js";
export {buildIntegrationResult} from "./kernel/integration.js";
export type {BuildIntegrationOptions, IntegrationOutcome} from "./kernel/integration.js";
export {InMemoryEventLog, JsonlEventLog} from "./state/event-log.js";
export type {EventLog, EventRecord, EventSource, JsonlEventLogOptions, LoggableEvent} from "./state/event-log.js";
export {countAttempts, reconstructExecution} from "./state/provenance.js";
export type {
  ExecutionOutcome,
  ExecutionSummary,
  IntegrationSummary,
  RunSummary,
  VerificationSummary,
} from "./state/provenance.js";
export {defaultShellRunner, runShellVerification} from "./adapters/verification/shell.js";
export type {ShellCheckSpec, ShellCommandResult, ShellRunner, ShellVerificationOptions, ShellVerificationOutput} from "./adapters/verification/shell.js";