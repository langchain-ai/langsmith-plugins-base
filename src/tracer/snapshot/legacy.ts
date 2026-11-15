import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CodingAgentIntegration } from "../../metadata/models.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { createLifecycleBridge } from "../../tracing/lifecycle/index.js";
import { TRACER_FOLDER_MODE } from "../constants.js";
import type { Bookmark, TracerPaths, TranscriptBuilder } from "../models.js";
import { tracerPaths } from "../paths.js";
import { readNewLines } from "../reader/reader.js";
import {
  IGNORED_RUNS,
  LEGACY_ENGINE_FOLDER,
  LEGACY_IMPORT_WINDOW_MS,
  LEGACY_QUEUE_WAIT_MS,
  LEGACY_STATE_FILE,
} from "./snapshot-constants.js";
import type { LegacyImport, LegacySession } from "./snapshot-models.js";
import { loadSnapshot, writeSnapshot } from "./snapshot.js";

function transcriptEnd(path: string, lineId: TranscriptBuilder["lineId"]): Bookmark {
  const bookmark: Bookmark = { path, offset: 0 };
  for (;;) if (readNewLines(bookmark, lineId).reachedEnd) return bookmark;
}

function importSessions(options: LegacyImport, sessions: LegacySession[], paths: TracerPaths) {
  const saved = loadSnapshot(paths.snapshot).snapshot;
  const cutoff = Date.now() - LEGACY_IMPORT_WINDOW_MS;
  for (const { sessionId, transcriptPath, updatedAt, tracingMode, writer } of sessions) {
    if (updatedAt < cutoff || writer === undefined) continue;
    const { lineId } = options.createBuilder({
      sessionId,
      savedState: undefined,
      sink: IGNORED_RUNS,
    });
    saved.sessions[sessionId] = {
      sessionId,
      integration: options.integration,
      writer,
      bookmarks: { [transcriptPath]: transcriptEnd(transcriptPath, lineId) },
      pendingNotes: [],
      builderState: undefined,
      tracingMode,
      ended: false,
    };
  }
  mkdirSync(paths.folder, { recursive: true, mode: TRACER_FOLDER_MODE });
  writeSnapshot(paths.snapshot, saved);
}

async function sendOldQueue(
  storageRoot: string,
  integration: CodingAgentIntegration,
  sessions: LegacySession[],
): Promise<boolean> {
  if (!existsSync(storageRoot)) return true;
  let sent = true;
  const queued = await createCaptureStore(storageRoot).enumerateSessions(integration);
  for (const { sessionId } of queued) {
    const writer = sessions.find((session) => session.sessionId === sessionId)?.writer;
    const bridge = writer && createLifecycleBridge({ storageRoot, integration, sessionId, writer });
    const result = await bridge?.drain();
    if (result?.status !== "drained" || result.pending + result.accountMismatch > 0) sent = false;
  }
  return sent;
}

export function upgradeLegacyState(options: LegacyImport): Promise<void> {
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
  const sending = sendOldQueue(legacyEngine, integration, sessions).catch(() => false);
  const timeout = delay(LEGACY_QUEUE_WAIT_MS, false, { ref: false });
  return Promise.race([sending, timeout]).then((sent) => {
    if (!sent) return;
    rmSync(legacyEngine, { recursive: true, force: true });
    rmSync(legacyState, { force: true });
  });
}
