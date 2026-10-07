import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { mutateFile } from "./corpus.mjs";
import { assertRealNodeModules, createScratch } from "./scratch.mjs";

/**
 * Evaluating one defect: prove the tree is green, break one thing, and say what
 * noticed.
 *
 * Three outcomes, and the distinction between them is the point of the tool:
 *
 *   caught       the suite failed on a mutated tree that was green beforehand.
 *   escaped      the suite passed on a mutated tree. Nothing noticed, which is a
 *                finding about the suite rather than about the defect.
 *   corpus-error the defect could not be evaluated at all — a drifted anchor, a
 *                scratch tree that is already red, a suite that never started, a
 *                run that never finished. Never reported as an escape, because an
 *                escape means "the check missed it", and a defect that never ran
 *                is not evidence of anything.
 *
 * Two suite runs per defect, and the second one is the reason for the first.
 * A single run cannot tell a check that noticed the mutation from a check that
 * was already failing: in a scratch environment any number of tests can fail for
 * reasons of their own, and every one of them would read as "caught". That is the
 * worst kind of wrong for this tool — a systematic false positive is
 * indistinguishable from the evidence it exists to produce. So the tree is run
 * once with nothing mutated, and only failures that were absent from that
 * baseline are credited to the mutation. A tree that cannot produce a clean
 * baseline cannot produce an attributable result, so it is a corpus error.
 *
 * The working tree is never written: the mutation goes into the scratch tree
 * `createScratch` copied, and the run happens there.
 */

/** Wall-clock ceiling for a single suite run, in milliseconds. */
export const RUN_TIMEOUT_MS = 300_000;

/**
 * Test files excluded from the suite an evaluation runs.
 *
 * This file is one of them, and it has to be: running the evaluator inside the
 * suite it evaluates would recurse, because the inner run would collect the
 * tests that spawn two full runs each, and the cost would grow with every
 * generation. The harness's own checks are not witnesses for a defect in the
 * product either, so keeping them out of the subject suite costs no coverage.
 *
 * It is exported rather than buried so a runner can refuse a corpus defect that
 * aims at an excluded file, instead of reporting that defect as an escape —
 * which is the one outcome a mutation run must never get wrong by omission.
 */
export const SUITE_EXCLUDE = ["tests/mutation-runner.test.ts"];

/**
 * Vitest's escape sequences, which it emits when it believes it has a terminal.
 * Stripped before matching so a parser that decides which failed files a run
 * produced cannot depend on that guess.
 */
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** A field is usable only if it is a non-empty string. */
function present(value) {
  return typeof value === "string" && value.length > 0;
}

/** Names a defect for an outcome, including when the entry has no usable id. */
function labelOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "<unnamed>";
  return present(value.id) ? value.id : "<unnamed>";
}

/**
 * Narrows a raw corpus entry to what evaluation actually needs, or says why it
 * cannot.
 *
 * `loadCorpus` hands back whatever the file contained — a `null` included, and
 * reported — so a caller that skips the narrowing gets a `TypeError` out of
 * `mutateFile` on its first property access, which belongs to no defect and
 * takes the run down with it. Only `file`, `find` and `replace` are required:
 * they are what applying the defect needs. `aimsAt`, `why` and `expected` are the
 * loader's business, and `id` is used to label errors when there is one.
 */
function narrowDefect(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const shape = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return { problem: `the corpus entry is not a defect: it is ${shape}, not an object` };
  }

  const missing = ["file", "find", "replace"].filter((field) => !present(value[field]));
  if (missing.length > 0) {
    return {
      problem:
        `the corpus entry is not a defect: field ` +
        `${missing.map((field) => `'${field}'`).join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} missing or not a non-empty string`,
    };
  }

  return {
    defect: {
      id: labelOf(value),
      file: value.file,
      find: value.find,
      replace: value.replace,
    },
  };
}

/** Where the suite's entry point is expected, resolved inside a scratch tree. */
function suiteRunnerPath(scratchPath) {
  return join(scratchPath, "node_modules", "vitest", "vitest.mjs");
}

/**
 * The failing test files a run reported, deduplicated and sorted.
 *
 * Attributing a catch to a file rather than to a test name is deliberate: one
 * file failing many tests is one piece of evidence, and a report that listed it
 * once per test would imply the suite had that many independent chances to
 * notice. Runs that failed without naming a file yield an empty list, which is
 * why the caller reads the exit code as well — a mutated tree that could not even
 * be collected is still a catch, and it must not be reported as a pass.
 */
export function extractFailingTests(output) {
  const found = new Set();
  for (const line of output.replace(ANSI_PATTERN, "").split("\n")) {
    const match = /^\s*FAIL\s+(tests\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts)\b/.exec(line);
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Runs the suite once in a scratch tree and resolves with everything the caller
 * needs to judge it. Never rejects: a run that could not happen is a result, not
 * an exception, because an exception here would belong to no defect.
 */
function runSuite(cwd, timeoutMs, runner) {
  return new Promise((resolve) => {
    const exclude = SUITE_EXCLUDE.flatMap((file) => ["--exclude", file]);
    const child = spawn(process.execPath, [runner, "run", "--reporter=dot", ...exclude], {
      cwd,
      // `CI` keeps the reporter's behaviour the same locally and under a runner.
      // `VITEST_*` is dropped because the outer run sets it: an inner run that
      // inherits the outer run's worker state is steered by it.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("VITEST") && key !== "CI",
        ),
      ),
      stdio: ["ignore", "pipe", "pipe"],
      // The child becomes a process-group leader, so the timeout can kill the
      // whole group. The suite forks its workers; killing only the direct child
      // leaves a live pool behind, and one wedged run becomes several on a
      // long-lived runner. The accepted cost: a CI-wide SIGTERM no longer
      // cascades into the child, which matters only when an external kill
      // happens at all.
      detached: true,
    });

    let output = "";
    let timedOut = false;

    // The timer is cleared on every exit path, including the timeout itself:
    // a live timer would keep this process alive until it fired.
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: the point of the ceiling is that a wedged run
      // cannot hold the evaluation open, and a process that ignores SIGTERM
      // would simply restart the wait. Take the whole process group — the
      // suite's forked workers included — since one survivor is one wedged
      // run that never finished dying.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is gone already, or negative-pid kill is unsupported here
        // (EPERM/ESRCH): the direct child alone is the fallback.
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output, code: code ?? -1, timedOut, spawnError: null });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ output, code: -1, timedOut, spawnError: error });
    });
  });
}

/**
 * Why a run is not a result, or null when it is one.
 *
 * Named by which run it was, because "the suite did not finish" means something
 * quite different before and after a mutation was applied, and a report that
 * cannot tell them apart cannot be acted on.
 */
function unevaluated(which, run, timeoutMs) {
  if (run.spawnError) {
    return `the suite could not start on the ${which} run: ${run.spawnError.message}`;
  }
  if (run.timedOut) {
    return (
      `the suite did not finish within ${timeoutMs}ms on the ${which} run, ` +
      "so the defect is unevaluated rather than escaped"
    );
  }
  return null;
}

/**
 * Evaluates one defect and reports which check noticed, if any.
 *
 * `defect` is the shape `loadCorpus` validates toward. Entries come back from it
 * unvalidated and typed `unknown`, so narrow them before calling; an entry that
 * is not a usable defect is reported as a corpus error here rather than allowed
 * to throw.
 *
 * `options.timeoutMs` overrides the per-run ceiling. It exists so the timeout
 * path can be exercised: a timeout is not evidence in either direction, and a
 * claim that only holds on a path nothing can reach is a claim nothing has
 * checked.
 */
export async function evaluateDefect(repoRoot, value, options = {}) {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const id = labelOf(value);
  const finish = (outcome, caughtBy, reason) => ({
    id,
    outcome,
    caughtBy,
    reason,
    durationMs: Date.now() - started,
  });

  const narrowed = narrowDefect(value);
  if (narrowed.problem) return finish("corpus-error", [], narrowed.problem);
  const defect = narrowed.defect;

  // Resolved before anything expensive is built, and before a tree is copied, so
  // a stale anchor costs a read rather than a run.
  let mutatedSource;
  try {
    ({ mutated: mutatedSource } = mutateFile(repoRoot, defect));
  } catch (error) {
    return finish("corpus-error", [], error.message);
  }

  let scratch;
  try {
    scratch = createScratch(repoRoot);
  } catch (error) {
    return finish("corpus-error", [], `the scratch tree could not be built: ${error.message}`);
  }

  try {
    try {
      assertRealNodeModules(scratch.path);
    } catch (error) {
      return finish("corpus-error", [], error.message);
    }

    const runner = suiteRunnerPath(scratch.path);
    if (!existsSync(runner)) {
      // Dependencies not installed in the copy. Reported rather than run: a
      // suite that never started would otherwise exit non-zero on every defect
      // and read as a catch with nothing behind it.
      return finish(
        "corpus-error",
        [],
        `the suite could not start: ${runner} is not in the scratch tree, ` +
          "so no check ran against this defect",
      );
    }

    // --- the baseline, with nothing mutated.
    const baseline = await runSuite(scratch.path, timeoutMs, runner);
    const baselineProblem = unevaluated("baseline", baseline, timeoutMs);
    if (baselineProblem) return finish("corpus-error", [], baselineProblem);

    const baselineFailures = extractFailingTests(baseline.output);
    if (baseline.code !== 0 || baselineFailures.length > 0) {
      const named = baselineFailures.length > 0 ? `: ${baselineFailures.join(", ")}` : "";
      return finish(
        "corpus-error",
        [],
        `the scratch tree was already failing before any defect was applied, so ` +
          `nothing about this defect can be attributed to it (baseline exit code ` +
          `${baseline.code}${named})`,
      );
    }

    // --- the mutation, which goes only into the copy.
    const target = join(scratch.path, defect.file);
    const outside = relative(scratch.path, target);
    if (outside === "" || outside.startsWith("..") || isAbsolute(outside)) {
      // The one write this module performs, guarded because it is the only way a
      // defect could reach the real working tree: `../..` in a target path
      // resolves outside the copy no matter where the copy lives.
      return finish(
        "corpus-error",
        [],
        `the defect's file '${defect.file}' resolves outside the scratch tree, ` +
          "so applying it could write to the real working tree",
      );
    }
    try {
      writeFileSync(target, mutatedSource);
    } catch (error) {
      return finish(
        "corpus-error",
        [],
        `the defect could not be written into the scratch tree: ${error.message}`,
      );
    }

    const mutated = await runSuite(scratch.path, timeoutMs, runner);
    const mutatedProblem = unevaluated("mutated", mutated, timeoutMs);
    if (mutatedProblem) return finish("corpus-error", [], mutatedProblem);

    const added = extractFailingTests(mutated.output).filter(
      (file) => !baselineFailures.includes(file),
    );

    if (mutated.code === 0) {
      return finish(
        "escaped",
        [],
        "the suite passed on a mutated tree that was green beforehand, so no " +
          "check is watching this defect",
      );
    }

    if (added.length > 0) {
      return finish(
        "caught",
        added,
        `caught by ${added.length} test file(s) that were green in the baseline: ` +
          `${added.join(", ")}`,
      );
    }

    // Failed without naming a file. That is still a catch — the mutated tree
    // cannot pass — but no check is credited for it, so the reason says so rather
    // than borrowing a file that did not fail. A collection or transform error is
    // the usual cause and is called out, because "a check noticed" would be a
    // lie about a run in which nothing was collected.
    const collectedNothing =
      /Failed to (load|parse)|No test files found|error TS\d+|SyntaxError/.test(mutated.output);
    return finish(
      "caught",
      [],
      collectedNothing
        ? "the mutated tree could not be built or collected, so the suite could not pass"
        : `the suite failed on the mutated tree (exit code ${mutated.code}) without ` +
          "naming a test file, so no individual check can be credited",
    );
  } finally {
    scratch.cleanup();
  }
}
