import type { RunSink } from "./models.js";

export const PLUGINS_BASE_FOLDER = "langsmith_plugins_base";
export const LOCK_FILE = "tracer.lock";
export const SNAPSHOT_FILE = "snapshot.json";
export const NOTES_FILE = "notes.jsonl";
export const LOG_FILE = "tracer.log";
export const TRACER_FOLDER_MODE = 0o700;

export const READ_CHUNK_BYTES = 1_048_576;
export const BOOKMARK_CHECK_BYTES = 1_048_576;
export const NEWLINE = 10;

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_TEMP_SUFFIX = ".tmp";
export const SNAPSHOT_FILE_MODE = 0o600;
export const LEGACY_IMPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LEGACY_ENGINE_FOLDER = "langsmith_engine";
export const LEGACY_STATE_FILE = "langsmith_state.json";
export const LEGACY_QUEUE_WAIT_MS = 30_000;
export const LEGACY_DROPPED_WARNING =
  "dropped {uploads} queued uploads from {sessions} old sessions: {missing} missing from the old state, {writerless} with tracing off, no known destination or no old rebuild code, {otherAccount} recorded under another account";
export const IGNORED_RUNS: RunSink = { post: () => undefined, patch: () => undefined };
