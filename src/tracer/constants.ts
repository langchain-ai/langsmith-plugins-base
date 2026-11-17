import type { RunSink, UploadQueuePolicy } from "./models.js";

export const PLUGINS_BASE_FOLDER = "langsmith_plugins_base";
export const LOCK_FILE = "tracer.lock";
export const SNAPSHOT_FILE = "snapshot.json";
export const NOTES_FILE = "notes.jsonl";
export const LOG_FILE = "tracer.log";
export const TRACER_FOLDER_MODE = 0o700;
export const NOTES_FILE_MODE = 0o600;

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

export const NOTES_ROTATE_BYTES = 10 * 1024 * 1024;
export const ROTATED_NOTES_SUFFIX = ".rotated.";
export const ROTATED_NOTES_NAME = /\.rotated\.(\d+)-(\d+)$/u;
export const ROTATED_NOTES_SETTLE_MS = 500;

export const UPLOAD_QUEUE_MAX_REQUESTS_IN_FLIGHT = 4;
export const MAX_QUEUED_BYTES = 40 * 1024 * 1024;
export const MAX_QUEUED_RUNS = 5_000;
export const UPLOAD_QUEUE_POLICY: UploadQueuePolicy = { retryBaseMs: 500, retryMaxMs: 10_000 };
export const UPLOAD_QUEUE_PATCH_FIELDS = ["inputs", "outputs", "end_time", "error"] as const;
export const UPLOAD_QUEUE_RETRY_LOG =
  "Upload of {count} runs to {destination} failed, retrying in {delayMs} ms: {reason}";
export const UPLOAD_QUEUE_DROPPED_LOG =
  "DROPPED run {runId} of session {sessionId} on {destination}, since LangSmith rejected it for good: {reason}{hint}";
export const UPLOAD_QUEUE_WRITER_FAILED_LOG =
  "DROPPED every run for an upload setting that could not be used: {reason}";

export const LOCK_TEMPORARY_SUFFIX = ".claim.";
export const LOCK_TAKEOVER_SUFFIX = ".takeover";
export const LOCK_ATTEMPTS = 3;
export const LOCK_TAKEOVER_STALE_MS = 1_000;

export const UNREAD_NOTES = { base: 0, offset: 0 };
export const HOOK_WARNING_PREFIX = "langsmith tracer: ";

export const READ_DEBOUNCE_MS = 20;
export const TICK_MS = 500;
export const IDLE_EXIT_MS = 3_000;
export const ABANDONED_EXIT_MS = 600_000;

export const SESSION_END_EVENT = "SessionEnd";
export const WORKER_STARTED_LOG = "worker started";
export const WORKER_STOPPED_LOG = "worker stopped";
export const WORKER_RESUMED_LOG = "worker resumed for late notes";
