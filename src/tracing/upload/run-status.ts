import type { RunEndStatus } from "./models.js";

const UPLOAD_RUN_END_STATUSES: ReadonlySet<unknown> = new Set(["cancelled", "interrupted"]);

/** The explicit run status the service honors on an ended run; anything else is dropped. */
export function runEndStatus(value: unknown): RunEndStatus | undefined {
  return UPLOAD_RUN_END_STATUSES.has(value) ? (value as RunEndStatus) : undefined;
}
