import type { LangSmithUploadWriterOptions } from "../../tracing/upload/models.js";
import type { StartTracerOptions, TracerSnapshot, TracingMode } from "../models.js";

export interface LoadedSnapshot {
  snapshot: TracerSnapshot;
  problem?: string;
}

export interface LegacySession {
  sessionId: string;
  transcriptPath: string;
  updatedAt: number;
  tracingMode?: TracingMode;
  writer?: LangSmithUploadWriterOptions;
}

export type LegacyImport = Pick<
  StartTracerOptions,
  "agentStateFolder" | "integration" | "createBuilder" | "readLegacySessions"
>;

export type LegacyGap = "missing" | "writerless" | "otherAccount" | "uploads" | "steps" | "turns";
export type LegacyGaps = Record<LegacyGap, number>;
