import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Corpus loading and anchor resolution.
 *
 * The single rule this module enforces: an anchor must match its target file
 * exactly once. An anchor matching zero times means the source moved and the
 * corpus is stale; matching several times means the defect is ambiguous. Both
 * are reported as corpus errors, and neither is ever reported as a defect that
 * escaped — that number means "the check missed it", and a defect that never
 * ran is not evidence of anything.
 */

export function loadCorpus(repoRoot) {
  const corpusPath = join(repoRoot, "defects", "mutations.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(corpusPath, "utf8"));
  } catch (error) {
    return {
      defects: [],
      errors: [
        {
          defectId: "<corpus>",
          file: corpusPath,
          message: `the corpus could not be read: ${error.message}`,
        },
      ],
    };
  }

  const defects = Array.isArray(parsed.defects) ? parsed.defects : [];
  const errors = [];
  const seen = new Set();

  for (const defect of defects) {
    for (const field of ["id", "aimsAt", "why", "file", "find", "replace", "expected"]) {
      if (typeof defect[field] !== "string" || defect[field].length === 0) {
        errors.push({
          defectId: defect.id ?? "<unnamed>",
          file: defect.file ?? corpusPath,
          message: `field '${field}' is missing or not a non-empty string`,
        });
      }
    }
    if (seen.has(defect.id)) {
      errors.push({
        defectId: defect.id,
        file: defect.file ?? corpusPath,
        message: "duplicate defect id",
      });
    }
    seen.add(defect.id);
  }

  return { defects, errors };
}

export function applyDefect(source, defect) {
  const occurrences = source.split(defect.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `anchor for defect '${defect.id}' matched ${occurrences} times in ${defect.file}; ` +
        `it must match exactly once`,
    );
  }
  return { mutated: source.replace(defect.find, defect.replace) };
}

/** Reads a target file and applies a defect; throws when the anchor is not unique. */
export function mutateFile(repoRoot, defect) {
  const absolute = join(repoRoot, defect.file);
  const source = readFileSync(absolute, "utf8");
  return applyDefect(source, defect);
}
