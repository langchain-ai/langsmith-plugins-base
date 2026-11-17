import type { CodingAgentMetadataOptions } from "../metadata/index.js";
import type {
  LangSmithUploadWriterOptions,
  LangSmithUploadWriter,
} from "../tracing/upload/models.js";

export type TranscriptLine = Record<string, unknown>;

export type TracingMode = "full" | "metadata" | "off";

export interface HookNote {
  integration: string;
  event: string;
  sessionId: string;
  transcriptPath?: string;
  agentId?: string;
  tracingMode?: TracingMode;
  details?: Record<string, unknown>;
  writer: LangSmithUploadWriterOptions;
}

export interface PositionedHookNote extends HookNote {
  transcriptSizes: Record<string, number>;
}

export interface Bookmark {
  path: string;
  offset: number;
  lastLineId?: string;
}

export interface ReadLine {
  line: TranscriptLine;
  end: number;
}

export interface RunPost {
  id: string;
  name: string;
  run_type: string;
  trace_id: string;
  dotted_order: string;
  parent_run_id?: string;
  start_time: string;
  end_time?: string;
  inputs?: unknown;
  outputs?: unknown;
  error?: string;
  extra?: Record<string, unknown>;
  metadata: CodingAgentMetadataOptions;
  tracingMode: TracingMode;
}

export type RunPatch = Partial<RunPost> &
  Pick<
    RunPost,
    "id" | "name" | "run_type" | "trace_id" | "dotted_order" | "metadata" | "tracingMode"
  >;

export interface RunSink {
  post: (run: RunPost) => void;
  patch: (patch: RunPatch) => void;
}

export interface TranscriptBuilder {
  lineId: (line: TranscriptLine) => string | undefined;
  readLine: (transcriptPath: string, line: TranscriptLine) => void;
  receiveNote: (note: HookNote) => void;
  transcripts: () => string[];
  turnOpen: () => boolean;
  state: () => unknown;
}

export interface BuilderContext {
  sessionId: string;
  savedState: unknown;
  sink: RunSink;
  tracingMode?: TracingMode | undefined;
}

export type CreateTranscriptBuilder = (context: BuilderContext) => TranscriptBuilder;

export interface SessionSnapshot {
  sessionId: string;
  integration: string;
  writer: LangSmithUploadWriterOptions;
  bookmarks: Record<string, Bookmark>;
  pendingNotes: PositionedHookNote[];
  builderState: unknown;
  tracingMode?: TracingMode | undefined;
  ended: boolean;
}

export interface NotesBookmark {
  base: number;
  offset: number;
}

export interface TracerSnapshot {
  version: number;
  sessions: Record<string, SessionSnapshot>;
  notes?: NotesBookmark;
}

export interface UploadQueue {
  post: (sessionId: string, writer: LangSmithUploadWriterOptions, run: RunPost) => void;
  patch: (sessionId: string, writer: LangSmithUploadWriterOptions, patch: RunPatch) => void;
  pendingFor: (sessionId: string) => number;
  idle: () => boolean;
  full: () => boolean;
  flush: () => void;
}

export interface TracerPaths {
  folder: string;
  lock: string;
  snapshot: string;
  notes: string;
  log: string;
}

export type ReadNewLines = (
  bookmark: Bookmark,
  lineId: (line: TranscriptLine) => string | undefined,
  log: (line: string) => void,
) => ReadLine[];

export interface SnapshotStore {
  load: () => TracerSnapshot | undefined;
  save: (snapshot: TracerSnapshot) => void;
}

export interface StartTracerOptions {
  agentStateFolder: string;
  integration: string;
  version: string;
  createBuilder: CreateTranscriptBuilder;
  readLegacySessions: (stateFile: string) => LegacySession[];
}

export interface WorkerOptions {
  paths: TracerPaths;
  createBuilder: CreateTranscriptBuilder;
  createQueue: (log: (line: string) => void) => UploadQueue;
  readNewLines: ReadNewLines;
  snapshots: SnapshotStore;
  version: string;
  upgradeState: (log: (line: string) => void) => void;
}

export type LineIdReader = TranscriptBuilder["lineId"];

export type LineVisitor = (text: Buffer, end: number) => boolean;

export interface TranscriptRead {
  lines: ReadLine[];
  notices: string[];
  reachedEnd: boolean;
}

export interface LoadedSnapshot {
  snapshot: TracerSnapshot;
  problem?: string;
}

export interface LegacyOpenTurn {
  rootRunId: string;
  afterLineId?: string;
  fromStart?: boolean;
  builderState?: unknown;
}

export interface LegacySession {
  sessionId: string;
  transcriptPath: string;
  updatedAt: number;
  tracingMode?: TracingMode;
  writer?: LangSmithUploadWriterOptions;
  recover?: () => Promise<void>;
  openTurn?: LegacyOpenTurn | undefined;
}

export type LegacyImport = Pick<
  StartTracerOptions,
  "agentStateFolder" | "integration" | "createBuilder" | "readLegacySessions"
>;

export type LegacyRecovery = Required<Pick<LegacySession, "sessionId" | "writer" | "recover">> &
  Pick<LegacySession, "openTurn">;
export type LegacyDropped = Record<"missing" | "writerless" | "otherAccount" | "uploads", number>;

export interface RotatedNotes {
  path: string;
  offset: number;
  rotatedAt: number;
}

export interface RotatedLeftover {
  path: string;
  base: number;
  nextBase: number;
}

export interface NotesRead {
  offset: number;
  size: number;
}

export interface UploadQueuePolicy {
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface UploadLane {
  key: string;
  writer: LangSmithUploadWriter;
  destinationId: string;
  ready: Set<QueuedRun>;
  failures: number;
  retryAt: number;
}

export interface QueuedWork {
  post?: RunPost | undefined;
  patch?: RunPatch | undefined;
}

export interface QueuedRun {
  key: string;
  runId: string;
  sessionId: string;
  lane: UploadLane;
  post?: RunPost | undefined;
  patch?: RunPatch | undefined;
  sending?: QueuedWork | undefined;
  sendAlone: boolean;
  failedUploads: number;
  bytes: number;
}

export type WorkerSession = Omit<SessionSnapshot, "builderState"> & {
  builder: TranscriptBuilder;
};

export interface LockHolder {
  pid: number;
  version: string;
}

export interface StopWorkerRequest {
  stopWorker: true;
  version: string;
}

export interface HookClientOptions {
  paths: TracerPaths;
  version: string;
  startWorker: () => void;
}

export type Log = (line: string) => void;
