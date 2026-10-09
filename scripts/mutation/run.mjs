#!/usr/bin/env node
/**
 * `npm run mutations`
 *
 * Evaluates every defect in `defects/mutations.json` and reports which check
 * caught each one. Exits non-zero when a defect escapes or cannot be evaluated,
 * so the rung can gate a build.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "./corpus.mjs";
import { evaluateDefect } from "./evaluate.mjs";
import { checkRatchet } from "./ratchet.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const only = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--defect") {
      const value = argv[i + 1];
      if (!value) {
        process.stderr.write("usage: npm run mutations -- [--defect <id>]\n");
        process.exit(2);
      }
      only.push(value);
      i += 1;
    }
  }
  return { only };
}

async function main() {
  const { only } = parseArgs(process.argv.slice(2));
  const { defects, errors } = loadCorpus(repoRoot);

  if (errors.length > 0) {
    process.stderr.write("the corpus is not valid:\n");
    for (const error of errors) {
      process.stderr.write(`  [${error.defectId}] ${error.file}: ${error.message}\n`);
    }
    process.exit(1);
  }

  const selected = only.length === 0
    ? defects
    : defects.filter((defect) => only.includes(defect.id));

  if (selected.length === 0) {
    process.stderr.write(`no defect matched ${only.join(", ")}\n`);
    process.exit(2);
  }

  process.stdout.write(`evaluating ${selected.length} defects\n\n`);

  const outcomes = [];
  for (const defect of selected) {
    process.stdout.write(`  ${defect.id} ... `);
    const outcome = await evaluateDefect(repoRoot, defect);
    outcomes.push(outcome);

    if (outcome.outcome === "caught") {
      const detail = outcome.caughtBy.length > 0 ? outcome.caughtBy.join(", ") : "build/collect";
      process.stdout.write(`caught by ${detail} (${outcome.durationMs}ms)\n`);
    } else if (outcome.outcome === "escaped") {
      process.stdout.write(`ESCAPED (${outcome.durationMs}ms)\n`);
    } else {
      process.stdout.write(`CORPUS ERROR (${outcome.durationMs}ms)\n`);
      process.stdout.write(`      ${outcome.reason}\n`);
    }
  }

  // The ratchet guards the whole corpus, so it is only meaningful when every
  // defect was evaluated. A filtered run reports its own results instead.
  //
  // aimsAt reaches the ratchet through each outcome itself: evaluateDefect
  // threads it from the corpus entry onto the DefectOutcome, so a caught
  // defect's aim is always checkable here. No filtering of aim-less outcomes —
  // the ratchet fails closed when an aim cannot be resolved, and that failure
  // is the one this wiring exists to produce.
  let ok = true;
  if (only.length === 0) {
    const ratchet = JSON.parse(readFileSync(join(repoRoot, "defects", "ratchet.json"), "utf8"));
    const verdict = checkRatchet(ratchet, outcomes);
    ok = verdict.ok;
    if (!ok) {
      process.stdout.write("\nratchet:\n");
      for (const problem of verdict.problems) {
        process.stdout.write(`  - ${problem}\n`);
      }
    }
  } else {
    ok = outcomes.every((outcome) => outcome.outcome === "caught");
  }

  const escaped = outcomes.filter((o) => o.outcome === "escaped").length;
  const errored = outcomes.filter((o) => o.outcome === "corpus-error").length;
  const caught = outcomes.length - escaped - errored;

  process.stdout.write(
    `\n${caught} caught, ${escaped} escaped, ${errored} unevaluated, ` +
      `of ${outcomes.length} defects\n`,
  );

  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`the mutation runner failed: ${error.stack}\n`);
  process.exit(1);
});
