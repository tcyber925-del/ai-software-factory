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
export {detectConflict, planSchedule} from "./kernel/scheduler.js";
export type {
  DecisionOutcome,
  DetectedConflict,
  PlanScheduleOptions,
  ScheduledWorkUnit,
  SchedulePlan,
  SchedulingDecision,
} from "./kernel/scheduler.js";
export {buildRepairContext, DEFAULT_MAX_REPAIR_ATTEMPTS, renderRepairPrompt, runRepairLoop} from "./kernel/repair.js";
export type {
  RepairAttempt,
  RepairAttemptOutcome,
  RepairContext,
  RepairLoopResult,
  RepairLoopStatus,
  RepairPolicy,
  RunRepairLoopOptions,
} from "./kernel/repair.js";
export {
  MINIMUM_NODE_MAJOR,
  REQUIRED_PROJECT_FILES,
  RUNTIME_REQUIREMENTS,
  formatDoctorReport,
  runDoctor,
} from "./doctor/doctor.js";
export type {Diagnostic, DiagnosticSeverity, DoctorOptions, DoctorReport, DoctorStatus, RequiredRuntime} from "./doctor/doctor.js";
export {
  DANGEROUS_OPERATION_SCREEN_IS_BEST_EFFORT,
  PROTECTED_BRANCHES,
  assessExecutionRisk,
  detectDangerousOperations,
  evaluateBranchWrite,
  evaluateCredentialAccess,
  isProtectedBranch,
  isolationStrength,
  minimumIsolationFor,
} from "./security/risk.js";
export type {ExecutionRiskInput, IsolationLevel, RiskAssessment, RiskClass} from "./security/risk.js";
export {evaluateSecurityGate, persistSecurityDecision, recordSecurityDecision} from "./security/index.js";
export type {SecurityDecisionKind, SecurityDecisionRecord, SecurityGateInput, SecurityGateResult} from "./security/index.js";
export { HermesRuntime, defaultHermesCommandRunner, HERMES_BIN } from "./adapters/hermes/index.js";
export type {
  HermesCommandResult,
  HermesCommandRunner,
  HermesRunState,
  HermesRuntimeOptions,
  HermesUsage,
} from "./adapters/hermes/index.js";
export { compileWorkUnit, evaluateEligibility, HARD_EXCLUDED_STATUS_TYPES, parseDeclaredRequirements } from "./adapters/linear/index.js";
export type {
  CompileOptions,
  DeclaredRequirements,
  EligibilityInput,
  IntakeDecision,
  LinearEligibilityConfig,
  LinearIssue,
  LinearOutcome,
  RefusalReason,
  ReflectInput,
  StatusTransition,
  WorkUnitTraceability,
} from "./adapters/linear/index.js";
export {createSystemProbe} from "./doctor/probe.js";
export type {DoctorProbe, RepositoryState, RuntimeAvailability, WorktreeSupport} from "./doctor/probe.js";
export {defaultShellRunner, runShellVerification} from "./adapters/verification/shell.js";
export type {ShellCheckSpec, ShellCommandResult, ShellRunner, ShellVerificationOptions, ShellVerificationOutput} from "./adapters/verification/shell.js";