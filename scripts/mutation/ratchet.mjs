/**
 * The ratchet.
 *
 * A number that can go down is a preference. This one exists so that removing a
 * defect to make the rung pass, or letting one go uncaught, is a visible failure
 * rather than a quieter gate.
 *
 * Pure function of its arguments: `checkRatchet` reads nothing from disk, so
 * the verdict cannot depend on the repo's state at the moment it is called.
 * The aim a caught defect must be caught by comes from the outcome itself —
 * the evaluator threads it through — or, failing that, from an explicit
 * `aimsAtById` map the caller supplies. When neither source resolves it, the
 * defect is flagged rather than waved through: a green verdict whose floor
 * never ran is the failure mode this guard exists to prevent.
 */

/** Pulls the aim out of an explicit id -> aimsAt index, whichever container it arrives in. */
function aimFromIndex(aimsAtById, id) {
  if (aimsAtById === undefined || aimsAtById === null) return undefined;
  const value = aimsAtById instanceof Map ? aimsAtById.get(id) : aimsAtById[id];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function checkRatchet(ratchet, outcomes, aimsAtById) {
  const problems = [];

  if (outcomes.length < ratchet.defects) {
    problems.push(
      `the corpus shrunk: ${outcomes.length} defects evaluated, ratchet requires ${ratchet.defects}`,
    );
  }

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
          : aimFromIndex(aimsAtById, outcome.id);
      if (aimsAt === undefined) {
        // Fail closed: without the aim, the floor never ran, and a green
        // verdict on that basis is indistinguishable from a real one.
        problems.push(`'${outcome.id}' was caught, but its aimsAt could not be checked`);
      } else {
        const caughtBy = Array.isArray(outcome.caughtBy) ? outcome.caughtBy : [];
        if (!caughtBy.includes(aimsAt)) {
          problems.push(
            `'${outcome.id}' was caught, but not by its aimsAt '${aimsAt}': caughtBy is [${caughtBy.join(", ")}]`,
          );
        }
      }
      continue;
    }
    // An outcome string this checker does not know is not fine by default:
    // a fourth outcome type a future evaluator adds must be loud, not invisible.
    problems.push(`'${outcome.id}' reported an unrecognized outcome '${String(outcome.outcome)}'`);
  }

  return { ok: problems.length === 0, problems };
}
