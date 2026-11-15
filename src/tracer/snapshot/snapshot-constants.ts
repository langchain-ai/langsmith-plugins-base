import type { RunSink } from "../models.js";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_TEMP_SUFFIX = ".tmp";
export const SNAPSHOT_FILE_MODE = 0o600;
export const LEGACY_IMPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LEGACY_ENGINE_FOLDER = "langsmith_engine";
export const LEGACY_STATE_FILE = "langsmith_state.json";
export const LEGACY_QUEUE_WAIT_MS = 30_000;
export const LEGACY_DROPPED_WARNING =
  "dropped {uploads} queued uploads from {sessions} old sessions: {missing} missing from the old state, {writerless} with tracing off or no known destination, {otherAccount} recorded under another account";
export const IGNORED_RUNS: RunSink = { post: () => undefined, patch: () => undefined };
