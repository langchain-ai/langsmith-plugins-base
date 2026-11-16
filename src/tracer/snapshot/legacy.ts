import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CodingAgentIntegration, CodingAgentMetadataOptions } from "../../metadata/models.js";
import {
  CAPTURE_JOBS_DIRECTORY,
  CAPTURE_TURNS_DIRECTORY,
} from "../../storage/capture/constants.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { CaptureDirectory, StoredCapture } from "../../storage/capture/models.js";
import { withFileLock } from "../../storage/index.js";
import { workerLockPath } from "../../tracing/background-worker/paths.js";
import { createLifecycleBridge } from "../../tracing/lifecycle/index.js";
import type {
  LifecycleBridge,
  LifecycleCaptureInput,
  LifecycleTurnEvidence,
} from "../../tracing/lifecycle/models.js";
import type { ReconstructionJob } from "../../tracing/reconstruction/index.js";
import type {
  LangSmithUploadWriterOptions,
  NormalizedRunSnapshot,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
} from "../../tracing/upload/models.js";
import { fillTemplate } from "../../utils/format.js";
import { TRACER_FOLDER_MODE } from "../constants.js";
import type { Bookmark, TracerPaths, TranscriptBuilder } from "../models.js";
import { tracerPaths } from "../paths.js";
import { readNewLines } from "../reader/reader.js";
import {
  IGNORED_RUNS,
  LEGACY_CLOSED_TURN_ERROR,
  LEGACY_DROPPED_WARNING,
  LEGACY_ENGINE_FOLDER,
  LEGACY_EVENT_PREFIX,
  LEGACY_IMPORT_WINDOW_MS,
  LEGACY_QUEUE_WAIT_MS,
  LEGACY_STATE_FILE,
  LEGACY_UNREBUILT_WARNING,
} from "./snapshot-constants.js";
import type { LegacyGaps, LegacyImport, LegacySession } from "./snapshot-models.js";
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

const endTimeOf = ({ normalizedPayload }: StoredCapture) => {
  const payload = normalizedPayload as Partial<PreparedRunPatchSubmission>;
  return (payload.run as NormalizedRunSnapshot).end_time ?? payload.patch?.values.end_time;
};

async function sendQueuedSteps(bridge: LifecycleBridge, jobs: StoredCapture[], gaps: LegacyGaps) {
  for (const { turnId, normalizedPayload, turnEvidence } of jobs) {
    const { sourceSnapshots = [] } = normalizedPayload as Partial<ReconstructionJob>;
    if (sourceSnapshots.length === 0) gaps.steps += 1;
    for (const { submission, sourceAgeStartedAtMs } of sourceSnapshots) {
      const eventId = `${LEGACY_EVENT_PREFIX}${submission.run.id}`;
      const step = { turnId, eventId, submission, turnEvidence, sourceAgeStartedAtMs };
      await bridge.capture(step as unknown as LifecycleCaptureInput);
    }
  }
}

async function closeOpenTurns(bridge: LifecycleBridge, records: StoredCapture[], gaps: LegacyGaps) {
  for (const root of records) {
    if ((root.turnEvidence as unknown as LifecycleTurnEvidence).rootRunId !== root.runId) continue;
    const turn = records.filter((record) => record.turnId === root.turnId);
    if (turn.some((record) => record.runId === root.runId && endTimeOf(record))) continue;
    const { privacyMode, run } = root.normalizedPayload as unknown as PreparedRunPostSubmission;
    const times = [run.start_time, ...turn.map(endTimeOf)].filter((time) => time !== undefined);
    const end_time = new Date(Math.max(...times.map((time) => new Date(time).getTime())));
    const { inputs: _inputs, outputs: _outputs, ...context } = run;
    gaps.turns += 1;
    await bridge.capture({
      turnId: root.turnId,
      eventId: `${LEGACY_EVENT_PREFIX}${root.runId}`,
      submission: {
        integration: root.integration as CodingAgentIntegration,
        privacyMode,
        metadata: root.metadataProvenance as unknown as CodingAgentMetadataOptions,
        operation: "patch",
        run: context,
        privacyContext: { status: "error" },
        patch: {
          fields: ["end_time", "error"],
          values: { end_time: end_time.toISOString(), error: LEGACY_CLOSED_TURN_ERROR },
        },
      },
      turnEvidence: {
        rootRunId: root.runId,
        childRunIds: [...new Set(turn.map(({ runId }) => runId))].filter((id) => id !== root.runId),
        closureState: "authoritative",
      },
    });
  }
}

async function sendOldSession(
  storageRoot: string,
  integration: CodingAgentIntegration,
  sessionId: string,
  writer: LangSmithUploadWriterOptions,
  gaps: LegacyGaps,
): Promise<boolean> {
  const bridge = createLifecycleBridge({ storageRoot, integration, sessionId, writer });
  const queued = async (directory: CaptureDirectory) =>
    (await createCaptureStore(storageRoot, directory).enumerate(integration, sessionId))
      .map(({ record }) => record)
      .filter((record) => record.destinationFingerprint === bridge.accountFingerprint);
  const send = async () => {
    await sendQueuedSteps(bridge, await queued(CAPTURE_JOBS_DIRECTORY), gaps);
    await closeOpenTurns(bridge, await queued(CAPTURE_TURNS_DIRECTORY), gaps);
    const result = await bridge.drain();
    if (result.status !== "drained" || result.pending > 0) return false;
    gaps.otherAccount += Number(result.accountMismatch > 0);
    gaps.uploads += result.accountMismatch;
    return true;
  };
  const scope = { integration, sessionId, accountFingerprint: bridge.accountFingerprint };
  const wait = { timeoutMs: LEGACY_QUEUE_WAIT_MS };
  return withFileLock(workerLockPath(storageRoot, scope), send, wait).catch(() => false);
}

async function sendOldQueue(
  storageRoot: string,
  integration: CodingAgentIntegration,
  sessions: LegacySession[],
  log: (line: string) => void,
): Promise<boolean> {
  if (!existsSync(storageRoot)) return true;
  let sent = true;
  const gaps = { missing: 0, writerless: 0, otherAccount: 0, uploads: 0, steps: 0, turns: 0 };
  const queued = new Map<string, number>();
  for (const directory of [CAPTURE_TURNS_DIRECTORY, CAPTURE_JOBS_DIRECTORY] as const) {
    const store = createCaptureStore(storageRoot, directory);
    for (const { sessionId, captures } of await store.enumerateSessions(integration))
      queued.set(sessionId, (queued.get(sessionId) ?? 0) + captures.length);
  }
  for (const [sessionId, uploads] of queued) {
    const session = sessions.find((listed) => listed.sessionId === sessionId);
    if (session?.writer === undefined) {
      gaps[session === undefined ? "missing" : "writerless"] += 1;
      gaps.uploads += uploads;
    } else
      sent =
        (await sendOldSession(storageRoot, integration, sessionId, session.writer, gaps)) && sent;
  }
  const sessionCount = gaps.missing + gaps.writerless + gaps.otherAccount;
  if (sessionCount > 0)
    log(fillTemplate(LEGACY_DROPPED_WARNING, { ...gaps, sessions: sessionCount }));
  if (gaps.turns + gaps.steps > 0) log(fillTemplate(LEGACY_UNREBUILT_WARNING, gaps));
  return sent;
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
  const sending = sendOldQueue(legacyEngine, integration, sessions, log).catch(() => false);
  const timeout = delay(LEGACY_QUEUE_WAIT_MS, false, { ref: false });
  return Promise.race([sending, timeout]).then((sent) => {
    if (!sent) return;
    rmSync(legacyEngine, { recursive: true, force: true });
    rmSync(legacyState, { force: true });
  });
}
