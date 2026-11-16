import type { LangSmithUploadWriterOptions } from "../../tracing/upload/models.js";
import type { StartTracerOptions, TracerSnapshot, TracingMode } from "../models.js";

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
