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
