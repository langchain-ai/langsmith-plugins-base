import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  localEndpoint,
  ROOT_ID,
  runPost,
  save,
  testBridge,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import { createReconstructionWorker } from "../../tracing/reconstruction/index.js";
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
  fs.mkdirSync(join(stateFolder, "langsmith_state.json.claims"));
  return stateFolder;
}

function legacy(sessionId: string, hoursAgo: number, extra?: Partial<LegacySession>) {
  const transcriptPath = join(transcripts, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, line("first") + line("last"));
  const updatedAt = Date.now() - hoursAgo * HOUR_MS;
  return { sessionId, transcriptPath, updatedAt, tracingMode: "full", writer, ...extra } as const;
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
  await save(oldEngine, ROOT_ID, "root", runPost("root"), turnEvidence("open", []));
  return { endpoint, oldEngine, storageRoot: join(stateFolder, "langsmith_engine") };
}

const openTurn = { childRunIds: [], closureState: "open" } as const;
const oldJob = { turnId: ROOT_ID, privacyMode: "full", turnEvidence: openTurn } as const;
const session = { integration: "claude-code" } as const;
const oldJobs = (
  storageRoot: string,
  bridge = testBridge(storageRoot, "http://127.0.0.1:9"),
  sessionId = "session-1",
) =>
  createReconstructionWorker({ ...session, sessionId, storageRoot, bridge, reconstruct: vi.fn() });

const recoverNothing = async () => undefined;
const sendingTo = (url: string, extra: Partial<LegacySession>) =>
  legacy("session-1", 1, { writer: writerFor(url), ...extra });
const recoverFailing = () => Promise.reject(new Error("boom"));
const drainAs = async (stateFolder: string, sendTo: ReturnType<typeof writerFor>) =>
  void (await testBridge(join(stateFolder, "langsmith_engine"), "", { writer: sendTo }).drain());

const snapshotPath = (stateFolder: string) =>
  join(stateFolder, "langsmith_plugins_base", "snapshot.json");
const importedSessions = (stateFolder: string) =>
  loadSnapshot(snapshotPath(stateFolder)).snapshot.sessions;

it("imports the last day's sessions with their mode and writer, cleaning up after the old worker exits", async () => {
  const stateFolder = oldInstall();
  const claims = join(stateFolder, "langsmith_engine", "session", "worker.claims");
  fs.mkdirSync(claims, { recursive: true });
  const recreate = `fs.mkdirSync(${JSON.stringify(claims)}, { recursive: true })`;
  const oldWorker = spawn(process.execPath, ["-e", `setTimeout(() => ${recreate}, 300)`]);
  fs.writeFileSync(join(claims, "claim.json"), JSON.stringify({ pid: oldWorker.pid }));
  const recent = legacy("recent", 2);
  const muted = legacy("muted", 1, { tracingMode: "off", writer: { ...writer, redact: false } });
  const sessions = [recent, muted, legacy("stale", 30)];
  await Promise.all([upgrade(stateFolder, sessions), once(oldWorker, "exit")]);
  expect(importedSessions(stateFolder)).toEqual({
    recent: imported(recent),
    muted: imported(muted),
  });
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
});

it("resumes an old open turn after its last line, its start or the end, with the builder's seed", async () => {
  const stateFolder = oldInstall();
  const sessions = [
    { rootRunId: "a", afterLineId: "first", builderState: 1 },
    { rootRunId: "b", fromStart: true, builderState: 2 },
    { rootRunId: "c", builderState: 3 },
    { rootRunId: "d", afterLineId: "gone", builderState: 4 },
  ].map((turn, index) => legacy(`open-${index}`, 1, { openTurn: turn }));
  await upgrade(stateFolder, sessions);
  const saved = importedSessions(stateFolder);
  const resumed = sessions.map(({ sessionId, transcriptPath }) => {
    const { offset, lastLineId } = saved[sessionId]!.bookmarks[transcriptPath]!;
    return [offset, lastLineId, saved[sessionId]!.builderState];
  });
  const end = (line("first") + line("last")).length;
  expect(resumed).toEqual([
    [line("first").length, "first", 1],
    [0, undefined, 2],
    [end, "last", 3],
    [end, "last", undefined],
  ]);
});

it("runs each old session's rebuild code once, handing its open turn to the new builder", async () => {
  const stateFolder = oldInstall();
  const { endpoint, oldEngine, storageRoot } = await queueOldRun(stateFolder);
  await oldJobs(storageRoot, oldEngine).enqueue({ ...oldJob, eventId: "call", sourceRefs: ["c"] });
  const recover = vi.fn(async () => void (await oldEngine.drain()));
  const oldSession = sendingTo(endpoint.url, { recover, openTurn: { rootRunId: ROOT_ID } });
  const warnings: string[] = [];
  await upgrade(stateFolder, [oldSession], warnings);
  expect(recover).toHaveBeenCalledOnce();
  expect(warnings).toEqual([]);
  expect(endpoint.requests.map(({ method, payload }) => [method, payload["id"]])).toEqual([
    ["POST", ROOT_ID],
  ]);
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
  await endpoint.close();
});

it("drops with a warning the old queue of a session with no writer or missing from the old state", async () => {
  const stateFolder = oldInstall();
  const { endpoint } = await queueOldRun(stateFolder);
  const missing = oldJobs(join(stateFolder, "langsmith_engine"), undefined, "session-2");
  await missing.enqueue({ ...oldJob, eventId: "call", sourceRefs: ["call"] });
  const { writer: _unknown, ...withoutWriter } = legacy("session-1", 1);
  const warnings: string[] = [];
  await upgrade(stateFolder, [withoutWriter], warnings);
  expect(importedSessions(stateFolder)).toEqual({});
  expect(warnings).toEqual([
    "dropped 2 queued uploads from 2 old sessions: 1 missing from the old state, 1 with tracing off, no known destination or no old rebuild code, 0 recorded under another account",
  ]);
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
  expect(endpoint.requests).toEqual([]);
  await endpoint.close();
});

it("drops old queued runs recorded under another account than the session's writer", async () => {
  const stateFolder = oldInstall();
  const { endpoint, oldEngine, storageRoot } = await queueOldRun(stateFolder);
  await oldJobs(storageRoot, oldEngine).enqueue({ ...oldJob, eventId: "call", sourceRefs: ["c"] });
  const warnings: string[] = [];
  const otherAccount = writerFor(endpoint.url, "another-key");
  const recover = () => drainAs(stateFolder, otherAccount);
  await upgrade(stateFolder, [legacy("session-1", 1, { writer: otherAccount, recover })], warnings);
  expect(warnings).toEqual([
    "dropped 2 queued uploads from 1 old sessions: 0 missing from the old state, 0 with tracing off, no known destination or no old rebuild code, 1 recorded under another account",
  ]);
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
  expect(endpoint.requests).toEqual([]);
  await endpoint.close();
});

it("keeps the old folder for a retry when its rebuild code fails or its queue cannot be sent", async () => {
  const stateFolder = oldInstall();
  const { endpoint } = await queueOldRun(stateFolder);
  const warnings: string[] = [];
  await upgrade(stateFolder, [sendingTo(endpoint.url, { recover: recoverFailing })], warnings);
  expect(warnings).toEqual(["could not send old session session-1: boom"]);
  await endpoint.close();
  await upgrade(stateFolder, [sendingTo(endpoint.url, { recover: recoverNothing })]);
  expect(fs.readdirSync(stateFolder)).toContain("langsmith_engine");
});

it("keeps an old queue its rebuild code could not finish, without closing its turns", async () => {
  const stateFolder = oldInstall();
  const { endpoint, oldEngine, storageRoot } = await queueOldRun(stateFolder);
  await oldJobs(storageRoot, oldEngine).enqueue({ ...oldJob, eventId: "call", sourceRefs: ["c"] });
  await upgrade(stateFolder, [sendingTo(endpoint.url, { recover: recoverNothing })]);
  expect(endpoint.requests.map(({ method, payload }) => [method, payload["id"]])).toEqual([
    ["POST", ROOT_ID],
  ]);
  await endpoint.close();
  expect(fs.readdirSync(stateFolder)).toHaveLength(4);
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

it("refuses a relative state folder so the purge cannot land in the working directory", () => {
  expect(() => upgrade("", [])).toThrow('refusing to import legacy state from relative folder ""');
});
