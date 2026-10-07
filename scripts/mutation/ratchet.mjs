/**
 * The ratchet.
 *
 * A number that can go down is a preference. This one exists so that removing a
 * defect to make the rung pass, or letting one go uncaught, is a visible failure
 * rather than a quieter gate.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds id -> aimsAt from the shipped corpus, so an outcome that does not
 * itself carry `aimsAt` can still be checked against its defect's aim. Any
 * problem reading the corpus yields an empty index: the floor check is then
 * simply unavailable, never fatal.
 */
function aimsAtIndex() {
  const index = new Map();
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const raw = JSON.parse(readFileSync(join(root, "defects", "mutations.json"), "utf8"));
    if (Array.isArray(raw.defects)) {
      for (const defect of raw.defects) {
        if (defect && typeof defect.id === "string" && typeof defect.aimsAt === "string") {
          index.set(defect.id, defect.aimsAt);
        }
      }
    }
  } catch {
    // The corpus is unreadable; the floor check has nothing to stand on.
  }
  return index;
}

export function checkRatchet(ratchet, outcomes) {
  const problems = [];

  if (outcomes.length < ratchet.defects) {
    problems.push(
      `the corpus shrunk: ${outcomes.length} defects evaluated, ratchet requires ${ratchet.defects}`,
    );
  }

  const byId = aimsAtIndex();

  for (const outcome of outcomes) {
    if (outcome.outcome === "escaped") {
      problems.push(`'${outcome.id}' escaped: the suite passed on a mutated tree`);
      continue;
    }
    if (outcome.outcome === "corpus-error") {
      problems.push(`'${outcome.id}' could not be evaluated; that is not a result`);
      continue;
    }
    if (outcome.outcome === "caught") {
      // The aim is a floor, not the whole debt: caughtBy may widen past aimsAt,
      // but a defect whose own aim is absent among the catchers is not healthy.
      const aimsAt =
        typeof outcome.aimsAt === "string" && outcome.aimsAt !== ""
          ? outcome.aimsAt
          : byId.get(outcome.id);
      if (aimsAt) {
        const caughtBy = Array.isArray(outcome.caughtBy) ? outcome.caughtBy : [];
        if (!caughtBy.includes(aimsAt)) {
          problems.push(
            `'${outcome.id}' was caught, but not by its aimsAt '${aimsAt}': caughtBy is [${caughtBy.join(", ")}]`,
          );
        }
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
