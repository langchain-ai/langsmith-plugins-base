import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  localEndpoint,
  runPost,
  save,
  testBridge,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import type { TranscriptBuilder } from "../models.js";
import { upgradeLegacyState } from "./legacy.js";
import type { LegacySession } from "./snapshot-models.js";
import { loadSnapshot, writeSnapshot } from "./snapshot.js";

vi.mock("node:fs", { spy: true });

const HOUR_MS = 60 * 60 * 1000;
const writer = { destinations: [], redact: true };
const transcripts = fs.mkdtempSync(join(tmpdir(), "tracer transcripts "));
const line = (uuid: string) => `${JSON.stringify({ uuid })}\n`;
const builder = { lineId: (read) => String(read.uuid) } as TranscriptBuilder;

function oldInstall(): string {
  const stateFolder = fs.mkdtempSync(join(tmpdir(), "tracer legacy "));
  fs.mkdirSync(join(stateFolder, "langsmith_engine"));
  fs.writeFileSync(join(stateFolder, "langsmith_state.json"), "{}");
  return stateFolder;
}

function legacy(
  sessionId: string,
  hoursAgo: number,
  extra?: Partial<LegacySession>,
): LegacySession {
  const transcriptPath = join(transcripts, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, line("first") + line("last"));
  const updatedAt = Date.now() - hoursAgo * HOUR_MS;
  return { sessionId, transcriptPath, updatedAt, tracingMode: "full", writer, ...extra };
}

const imported = ({ sessionId, transcriptPath: path, tracingMode, ...rest }: LegacySession) => ({
  sessionId,
  integration: "claude-code",
  writer: rest.writer,
  bookmarks: {
    [path]: { path, offset: (line("first") + line("last")).length, lastLineId: "last" },
  },
  pendingNotes: [],
  tracingMode,
  ended: false,
});

const upgrade = (stateFolder: string, sessions: LegacySession[], warnings: string[] = []) =>
  upgradeLegacyState(
    {
      agentStateFolder: stateFolder,
      integration: "claude-code",
      createBuilder: () => builder,
      readLegacySessions: () => sessions,
    },
    (warning) => warnings.push(warning),
  );

async function queueOldRun(stateFolder: string) {
  const endpoint = await localEndpoint();
  const oldEngine = testBridge(join(stateFolder, "langsmith_engine"), endpoint.url);
  await save(oldEngine, "turn", "event", runPost("root"));
  return endpoint;
}

const snapshotPath = (stateFolder: string) =>
  join(stateFolder, "langsmith_plugins_base", "snapshot.json");
const importedSessions = (stateFolder: string) =>
  loadSnapshot(snapshotPath(stateFolder)).snapshot.sessions;

it("imports the last day's sessions from their transcript's end with their own mode and writer", async () => {
  const stateFolder = oldInstall();
  const recent = legacy("recent", 2);
  const muted = legacy("muted", 1, { tracingMode: "off", writer: { ...writer, redact: false } });
  await upgrade(stateFolder, [recent, muted, legacy("stale", 30)]);
  expect(importedSessions(stateFolder)).toEqual({
    recent: imported(recent),
    muted: imported(muted),
  });
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
});

it("skips a session with no writer and drops its old queue with a warning", async () => {
  const stateFolder = oldInstall();
  const endpoint = await queueOldRun(stateFolder);
  const { writer: _unknown, ...withoutWriter } = legacy("session-1", 1);
  const warnings: string[] = [];
  await upgrade(stateFolder, [withoutWriter], warnings);
  expect(importedSessions(stateFolder)).toEqual({});
  expect(warnings).toEqual([
    "dropped 1 queued uploads from 1 old sessions: 0 missing from the old state, 1 with tracing off or no known destination",
  ]);
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
  expect(endpoint.requests).toEqual([]);
  await endpoint.close();
});

it("drops the old queue of a session missing from the old state with a warning", async () => {
  const stateFolder = oldInstall();
  const endpoint = await queueOldRun(stateFolder);
  const warnings: string[] = [];
  await upgrade(stateFolder, [], warnings);
  expect(warnings).toEqual([
    "dropped 1 queued uploads from 1 old sessions: 1 missing from the old state, 0 with tracing off or no known destination",
  ]);
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
  await endpoint.close();
});

it("sends the old engine's queued runs before purging its folder", async () => {
  const stateFolder = oldInstall();
  const endpoint = await queueOldRun(stateFolder);
  await upgrade(stateFolder, [legacy("session-1", 1, { writer: writerFor(endpoint.url) })]);
  expect(endpoint.requests).toHaveLength(1);
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
  await endpoint.close();
});

it("keeps the old folder to retry later when its queue cannot be sent", async () => {
  const stateFolder = oldInstall();
  const endpoint = await queueOldRun(stateFolder);
  await endpoint.close();
  await upgrade(stateFolder, [legacy("session-1", 1, { writer: writerFor(endpoint.url) })]);
  expect(fs.readdirSync(stateFolder).toSorted()).toEqual([
    "langsmith_engine",
    "langsmith_plugins_base",
    "langsmith_state.json",
  ]);
});

it("leaves the old folder and state file untouched when killed before the snapshot rename", () => {
  const stateFolder = oldInstall();
  vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("killed");
  });
  expect(() => upgrade(stateFolder, [legacy("recent", 1)])).toThrow("killed");
  expect(fs.existsSync(join(stateFolder, "langsmith_engine"))).toBe(true);
  expect(fs.existsSync(join(stateFolder, "langsmith_state.json"))).toBe(true);
});

it("keeps the worker's progress when rerun after a kill between the rename and the purge", async () => {
  const stateFolder = oldInstall();
  const recent = legacy("recent", 1);
  await upgrade(stateFolder, [recent]);
  const advanced = { ...imported(recent), writer, builderState: 1 };
  writeSnapshot(snapshotPath(stateFolder), { version: 1, sessions: { recent: advanced } });
  fs.mkdirSync(join(stateFolder, "langsmith_engine"));
  fs.writeFileSync(join(stateFolder, "langsmith_state.json"), "{}");
  await upgrade(stateFolder, [legacy("other", 1)]);
  expect(importedSessions(stateFolder)).toEqual({ recent: advanced });
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
});

it("writes nothing when rerun after a completed import", async () => {
  const stateFolder = oldInstall();
  await upgrade(stateFolder, [legacy("recent", 1)]);
  const rename = vi.spyOn(fs, "renameSync");
  rename.mockClear();
  await upgrade(stateFolder, [legacy("other", 1)]);
  expect(rename).not.toHaveBeenCalled();
});

it("refuses a relative state folder so the purge cannot land in the working directory", () => {
  expect(() => upgrade("", [])).toThrow('refusing to import legacy state from relative folder ""');
});
