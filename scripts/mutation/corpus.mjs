import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Corpus loading and anchor resolution.
 *
 * The rule this module enforces: a defect must be applicable, or be reported.
 * An anchor matching zero times means the source moved and the corpus is stale;
 * matching several times means the defect is ambiguous. A target file that does
 * not exist, an `aimsAt` naming no test, or an `expected` outside the known set
 * are all the same class of problem. Each is reported as a corpus error and none
 * of them is ever reported as a defect that escaped — that number means "the
 * check missed it", and a defect that never ran is not evidence of anything.
 *
 * `loadCorpus` performs every check a caller would otherwise have to repeat, and
 * returns them as data rather than throwing. `applyDefect` still throws, because
 * a caller that is mid-run needs to stop; it throws a `CorpusError`, which
 * carries `defectId` and `file` so a runner can tell a stale corpus apart from a
 * crash without matching against prose.
 */

const REQUIRED_FIELDS = ["id", "aimsAt", "why", "file", "find", "replace", "expected"];
const ALLOWED_EXPECTED = new Set(["caught", "escaped"]);

/**
 * A corpus problem, in the shape the task contract documents: `defectId`, `file`
 * and `message`. `defectId` and `file` are own enumerable properties so a caller
 * can branch on them; `message` is made enumerable too, so a `CorpusError`
 * survives `JSON.stringify` into a machine-readable report instead of collapsing
 * to `{}` the way a bare `Error` does.
 */
export class CorpusError extends Error {
  constructor(defectId, file, message) {
    super(message);
    this.name = "CorpusError";
    this.defectId = defectId;
    this.file = file;
    Object.defineProperty(this, "message", {
      value: message,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/** A field is usable only if it is a non-empty string. */
function present(value) {
  return typeof value === "string" && value.length > 0;
}

/** Reads a file, or returns null. Absence is data here, not an exception. */
function readOrNull(absolute) {
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function countOccurrences(source, find) {
  return source.split(find).length - 1;
}

export function loadCorpus(repoRoot) {
  const corpusPath = join(repoRoot, "defects", "mutations.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(corpusPath, "utf8"));
  } catch (error) {
    return {
      defects: [],
      errors: [
        new CorpusError(
          "<corpus>",
          corpusPath,
          `the corpus could not be read: ${error.message}`,
        ),
      ],
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      defects: [],
      errors: [
        new CorpusError(
          "<corpus>",
          corpusPath,
          "the corpus must be a JSON object holding a 'defects' array",
        ),
      ],
    };
  }

  const errors = [];

  // A missing or wrong-typed key is a corpus error, never a silent zero. An
  // empty array is legitimate: it is a real state to report to the operator,
  // and treating it as malformed would only teach them to ignore this list.
  if (!Array.isArray(parsed.defects)) {
    errors.push(
      new CorpusError(
        "<corpus>",
        corpusPath,
        parsed.defects === undefined
          ? "the corpus has no 'defects' array, so there is nothing to run"
          : `the corpus 'defects' entry is ${typeof parsed.defects}, not an array, ` +
            "so there is nothing to run",
      ),
    );
    return { defects: [], errors };
  }

  const defects = parsed.defects;
  const seen = new Set();

  for (const defect of defects) {
    // One bad entry must not hide the entries after it, and must not take the
    // whole run down with it.
    if (defect === null || typeof defect !== "object" || Array.isArray(defect)) {
      const shape = defect === null ? "null" : Array.isArray(defect) ? "array" : typeof defect;
      errors.push(
        new CorpusError(
          "<unnamed>",
          corpusPath,
          `defect entry is not an object (found ${shape})`,
        ),
      );
      continue;
    }

    const id = present(defect.id) ? defect.id : null;
    const file = present(defect.file) ? defect.file : null;
    const find = present(defect.find) ? defect.find : null;
    const aimsAt = present(defect.aimsAt) ? defect.aimsAt : null;
    const label = id ?? "<unnamed>";
    const where = file ?? corpusPath;

    for (const field of REQUIRED_FIELDS) {
      if (!present(defect[field])) {
        errors.push(
          new CorpusError(label, where, `field '${field}' is missing or not a non-empty string`),
        );
      }
    }

    // `expected` drives the runner's pass condition, so a value it cannot
    // interpret must not pass as though it had.
    if (present(defect.expected) && !ALLOWED_EXPECTED.has(defect.expected)) {
      errors.push(
        new CorpusError(
          label,
          where,
          `field 'expected' must be one of ${[...ALLOWED_EXPECTED].join(", ")}, ` +
            `but found '${defect.expected}'`,
        ),
      );
    }

    if (id !== null) {
      if (seen.has(id)) {
        errors.push(new CorpusError(label, where, "duplicate defect id"));
      }
      seen.add(id);
    }

    // Only resolve a field that already passed the shape check, so a missing
    // `file` or `find` is reported once rather than as follow-on noise.
    if (file !== null) {
      const source = readOrNull(join(repoRoot, file));
      if (source === null) {
        errors.push(
          new CorpusError(label, where, `target file '${file}' could not be read`),
        );
      } else if (find !== null) {
        const occurrences = countOccurrences(source, find);
        if (occurrences !== 1) {
          errors.push(
            new CorpusError(
              label,
              where,
              `anchor matched ${occurrences} times in ${file}; it must match exactly once`,
            ),
          );
        }
      }
    }

    if (aimsAt !== null && readOrNull(join(repoRoot, aimsAt)) === null) {
      errors.push(
        new CorpusError(label, where, `aims at no test file: '${aimsAt}' does not exist`),
      );
    }
  }

  return { defects, errors };
}

export function applyDefect(source, defect) {
  const occurrences = countOccurrences(source, defect.find);
  if (occurrences !== 1) {
    const label = present(defect.id) ? defect.id : "<unnamed>";
    const where = present(defect.file) ? defect.file : "<unknown>";
    throw new CorpusError(
      label,
      where,
      `anchor for defect '${label}' matched ${occurrences} times in ${where}; ` +
        `it must match exactly once`,
    );
  }
  // The replacement is returned from a function so String.replace treats it as
  // literal text. Otherwise a corpus author writing `$1`, `$&` or `$'` gets
  // silently different source, with no error and nothing to notice it by.
  return { mutated: source.replace(defect.find, () => defect.replace) };
}

/** Reads a target file and applies a defect; throws when the anchor is not unique. */
export function mutateFile(repoRoot, defect) {
  const absolute = join(repoRoot, defect.file);
  const source = readFileSync(absolute, "utf8");
  return applyDefect(source, defect);
}
