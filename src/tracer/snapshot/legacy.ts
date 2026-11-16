import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CodingAgentIntegration } from "../../metadata/models.js";
import {
  CAPTURE_JOBS_DIRECTORY,
  CAPTURE_TURNS_DIRECTORY,
} from "../../storage/capture/constants.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { scopeOf } from "../../storage/capture/scope.js";
import { FILE_LOCK_DIRECTORY_SUFFIX, FILE_LOCK_POLL_INTERVAL_MS } from "../../storage/constants.js";
import { processIsAlive } from "../../storage/file-lock-support.js";
import type { FileLockClaim } from "../../storage/models.js";
import { LIFECYCLE_POST_EVENT_KIND } from "../../tracing/lifecycle/constants.js";
import { createLifecycleBridge } from "../../tracing/lifecycle/index.js";
import { describe } from "../../utils/errors.js";
import { fillTemplate } from "../../utils/format.js";
import { TRACER_FOLDER_MODE } from "../constants.js";
import type { Bookmark, TracerPaths, TranscriptBuilder } from "../models.js";
import { tracerPaths } from "../paths.js";
import { readNewLines } from "../reader/reader.js";
import {
  IGNORED_RUNS,
  LEGACY_DROPPED_WARNING,
  LEGACY_ENGINE_FOLDER,
  LEGACY_IMPORT_WINDOW_MS,
  LEGACY_QUEUE_WAIT_MS,
  LEGACY_STATE_FILE,
} from "./snapshot-constants.js";
import type {
  LegacyDropped,
  LegacyImport,
  LegacyOpenTurn,
  LegacyRecovery,
  LegacySession,
} from "./snapshot-models.js";
import { loadSnapshot, writeSnapshot } from "./snapshot.js";

function transcriptEnd(path: string, lineId: TranscriptBuilder["lineId"]): Bookmark {
  const bookmark: Bookmark = { path, offset: 0 };
  for (;;) if (readNewLines(bookmark, lineId).reachedEnd) return bookmark;
}

function openTurnStart(path: string, lineId: TranscriptBuilder["lineId"], turn: LegacyOpenTurn) {
  if (turn.fromStart) return { path, offset: 0 };
  if (turn.afterLineId === undefined) return transcriptEnd(path, lineId);
  const bookmark: Bookmark = { path, offset: 0 };
  for (;;) {
    const { lines, reachedEnd } = readNewLines(bookmark, lineId);
    const after = lines.find(({ line }) => lineId(line) === turn.afterLineId);
    if (after !== undefined) return { path, offset: after.end, lastLineId: turn.afterLineId };
    if (reachedEnd) return undefined;
  }
}

function importSessions(options: LegacyImport, sessions: LegacySession[], paths: TracerPaths) {
  const saved = loadSnapshot(paths.snapshot).snapshot;
  const cutoff = Date.now() - LEGACY_IMPORT_WINDOW_MS;
  for (const { sessionId, transcriptPath, updatedAt, tracingMode, writer, openTurn } of sessions) {
    if (updatedAt < cutoff || writer === undefined) continue;
    const { lineId } = options.createBuilder({
      sessionId,
      savedState: undefined,
      sink: IGNORED_RUNS,
    });
    const resume = openTurn && openTurnStart(transcriptPath, lineId, openTurn);
    saved.sessions[sessionId] = {
      sessionId,
      integration: options.integration,
      writer,
      bookmarks: { [transcriptPath]: resume ?? transcriptEnd(transcriptPath, lineId) },
      pendingNotes: [],
      builderState: resume === undefined ? undefined : openTurn?.builderState,
      tracingMode,
      ended: false,
    };
  }
  mkdirSync(paths.folder, { recursive: true, mode: TRACER_FOLDER_MODE });
  writeSnapshot(paths.snapshot, saved);
}

async function handOverOpenTurn(
  storageRoot: string,
  integration: CodingAgentIntegration,
  sessionId: string,
  rootRunId: string,
) {
  for (const directory of [CAPTURE_TURNS_DIRECTORY, CAPTURE_JOBS_DIRECTORY] as const) {
    const store = createCaptureStore(storageRoot, directory);
    for (const { record } of await store.enumerateTurn(integration, sessionId, rootRunId))
      if (record.runId !== rootRunId || record.eventKind !== LIFECYCLE_POST_EVENT_KIND)
        await store.remove(scopeOf(record));
  }
}

async function sendOldSession(
  storageRoot: string,
  integration: CodingAgentIntegration,
  { sessionId, writer, recover, openTurn }: LegacyRecovery,
  dropped: LegacyDropped,
): Promise<boolean> {
  if (openTurn !== undefined)
    await handOverOpenTurn(storageRoot, integration, sessionId, openTurn.rootRunId);
  await recover();
  const bridge = createLifecycleBridge({ storageRoot, integration, sessionId, writer });
  const result = await bridge.drain();
  const account = bridge.accountFingerprint;
  const jobs = await createCaptureStore(storageRoot, CAPTURE_JOBS_DIRECTORY).enumerate(
    integration,
    sessionId,
  );
  const ownJobs = jobs.filter(({ record }) => record.destinationFingerprint === account);
  if (result.status !== "drained" || result.pending > 0 || ownJobs.length > 0) return false;
  const otherAccount = result.accountMismatch + jobs.length;
  dropped.otherAccount += Number(otherAccount > 0);
  dropped.uploads += otherAccount;
  return true;
}

async function sendOldQueue(
  storageRoot: string,
  integration: CodingAgentIntegration,
  sessions: LegacySession[],
  log: (line: string) => void,
): Promise<boolean> {
  if (!existsSync(storageRoot)) return true;
  let sent = true;
  const dropped = { missing: 0, writerless: 0, otherAccount: 0, uploads: 0 };
  const queued = new Map<string, number>();
  for (const directory of [CAPTURE_TURNS_DIRECTORY, CAPTURE_JOBS_DIRECTORY] as const) {
    const store = createCaptureStore(storageRoot, directory);
    for (const { sessionId, captures } of await store.enumerateSessions(integration))
      queued.set(sessionId, (queued.get(sessionId) ?? 0) + captures.length);
  }
  for (const [sessionId, uploads] of queued) {
    const session = sessions.find((listed) => listed.sessionId === sessionId);
    const { writer, recover, openTurn } = session ?? {};
    if (writer === undefined || recover === undefined) {
      dropped[session === undefined ? "missing" : "writerless"] += 1;
      dropped.uploads += uploads;
      continue;
    }
    const recovery = { sessionId, writer, recover, openTurn };
    const done = await sendOldSession(storageRoot, integration, recovery, dropped).catch(
      (error: unknown) => {
        log(`could not send old session ${sessionId}: ${describe(error)}`);
        return false;
      },
    );
    sent = done && sent;
  }
  const sessionCount = dropped.missing + dropped.writerless + dropped.otherAccount;
  if (sessionCount > 0)
    log(fillTemplate(LEGACY_DROPPED_WARNING, { ...dropped, sessions: sessionCount }));
  return sent;
}

function lockHolders(folder: string): number[] | undefined {
  try {
    return readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.parentPath.endsWith(FILE_LOCK_DIRECTORY_SUFFIX))
      .map(({ parentPath, name }) => readFileSync(join(parentPath, name), "utf8"))
      .map((claim) => (JSON.parse(claim) as FileLockClaim).pid);
  } catch {
    return existsSync(folder) ? undefined : [];
  }
}

async function oldWorkersStopped(folders: string[]): Promise<true> {
  const holders = new Set<number>();
  for (;;) {
    const scans = folders.map((folder) => lockHolders(folder));
    for (const pid of scans.flat()) if (pid !== undefined) holders.add(pid);
    for (const pid of holders)
      if (pid === process.pid || processIsAlive(pid) !== true) holders.delete(pid);
    if (holders.size === 0 && !scans.includes(undefined)) return true;
    await delay(FILE_LOCK_POLL_INTERVAL_MS);
  }
}

export function upgradeLegacyState(
  options: LegacyImport,
  log: (line: string) => void,
): Promise<void> {
  if (!isAbsolute(options.agentStateFolder)) {
    throw new Error(
      `refusing to import legacy state from relative folder "${options.agentStateFolder}"`,
    );
  }
  const legacyEngine = join(options.agentStateFolder, LEGACY_ENGINE_FOLDER);
  const legacyState = join(options.agentStateFolder, LEGACY_STATE_FILE);
  if (!existsSync(legacyEngine) && !existsSync(legacyState)) return Promise.resolve();
  const paths = tracerPaths(options.agentStateFolder);
  const sessions = existsSync(legacyState) ? options.readLegacySessions(legacyState) : [];
  if (!existsSync(paths.snapshot)) importSessions(options, sessions, paths);
  const integration = options.integration as CodingAgentIntegration;
  const stateClaims = `${legacyState}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  const sending = sendOldQueue(legacyEngine, integration, sessions, log)
    .then((sent) => sent && oldWorkersStopped([legacyEngine, stateClaims]))
    .catch(() => false);
  const timeout = delay(LEGACY_QUEUE_WAIT_MS, false, { ref: false });
  return Promise.race([sending, timeout]).then((sent) => {
    if (!sent) return;
    rmSync(legacyEngine, { recursive: true, force: true });
    rmSync(legacyState, { force: true });
    rmSync(stateClaims, { recursive: true, force: true });
  });
}
