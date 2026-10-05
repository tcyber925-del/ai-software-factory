import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Durable, append-only execution event log.
 *
 * V1 constraint: no database. Records are newline-delimited JSON appended to a
 * local file.
 *
 * Append-only is a property of the format, not a convention: each record is one
 * line, and the file is only ever opened for append. Line order *is* the
 * sequence, so no counter can drift out of sync with the stored history. There
 * is deliberately no update, delete, or truncate operation.
 */

export type EventSource = "factory" | "runtime";

export interface LoggableEvent {
  workUnitId: string;
  /** Correlates every event belonging to one execution attempt. */
  runId: string;
  /** Set when this run was spawned by another, e.g. a repair attempt. */
  parentRunId?: string;
  source: EventSource;
  type: string;
  payload: Record<string, unknown>;
}

/** An event as persisted, with the log-assigned sequence number. */
export interface EventRecord extends LoggableEvent {
  seq: number;
  recordedAt: string;
}

export interface EventLog {
  append(events: LoggableEvent[]): Promise<void>;
  readAll(): Promise<EventRecord[]>;
}

export interface JsonlEventLogOptions {
  now?: () => string;
}

export class JsonlEventLog implements EventLog {
  readonly #filePath: string;
  readonly #now: () => string;

  constructor(filePath: string, options: JsonlEventLogOptions = {}) {
    this.#filePath = filePath;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get filePath(): string {
    return this.#filePath;
  }

  async append(events: LoggableEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(dirname(this.#filePath), { recursive: true });
    const recordedAt = this.#now();
    // Single append of a single buffer keeps each batch contiguous on disk.
    const payload = events.map((event) => JSON.stringify({ ...event, recordedAt })).join("\n");
    await appendFile(this.#filePath, `${payload}\n`, "utf8");
  }

  async readAll(): Promise<EventRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return parseRecords(raw, this.#now);
  }
}

/** In-memory log for tests and for callers that must not touch the filesystem. */
export class InMemoryEventLog implements EventLog {
  readonly #events: LoggableEvent[] = [];
  readonly #now: () => string;

  constructor(options: JsonlEventLogOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async append(events: LoggableEvent[]): Promise<void> {
    this.#events.push(...events);
  }

  async readAll(): Promise<EventRecord[]> {
    return parseRecords(this.#events.map((event) => JSON.stringify(event)).join("\n"), this.#now);
  }

  /** Test helper: the raw stored events, without derived fields. */
  stored(): LoggableEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }
}

/**
 * Reconstructs sequence numbers from line order. A blank line, or a line that is
 * not parseable, is skipped rather than aborting the whole read: a partially
 * written trailing record must not make earlier history unreadable.
 */
function parseRecords(raw: string, fallbackTime: () => string): EventRecord[] {
  const records: EventRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isLoggableEvent(parsed)) continue;
    records.push({ ...parsed, seq: records.length + 1, recordedAt: parsed.recordedAt ?? fallbackTime() });
  }
  return records;
}

function isLoggableEvent(value: unknown): value is LoggableEvent & { recordedAt?: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["workUnitId"] === "string" &&
    typeof candidate["runId"] === "string" &&
    (candidate["source"] === "factory" || candidate["source"] === "runtime") &&
    typeof candidate["type"] === "string" &&
    typeof candidate["payload"] === "object" &&
    candidate["payload"] !== null
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}