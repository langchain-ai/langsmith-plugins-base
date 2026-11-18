import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { childEnvironment, moduleUrl } from "../../test-support/tracing/delivery.js";
import { waitFor } from "../../test-support/wait.js";
import type { HookNote } from "../types.js";
import { tracerPaths } from "../paths.js";
import { sendHookNote } from "./hook.js";
import { IDLE_EXIT_MS, TICK_MS, WORKER_STARTED_LOG } from "../constants.js";
import { processIsAlive } from "../../storage/file-lock-support.js";

vi.setConfig({ testTimeout: 15_000 });

const dist = moduleUrl("dist/tracer");
const VERSION = "1.0.0";
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "tw-"));
  const stateFolder = join(home, "state");
  const paths = tracerPaths(stateFolder);
  writeFileSync(join(home, "main.jsonl"), "");
  return {
    home,
    stateFolder,
    paths,
    record: join(home, "record"),
    main: join(home, "main.jsonl"),
    subagent: join(home, "subagent.jsonl"),
  };
}

type Sandbox = ReturnType<typeof sandbox>;

function startWorker(box: Sandbox, version = VERSION): ChildProcess {
  const program = fileURLToPath(new URL("./fixtures/worker.mjs", import.meta.url));
  const input = JSON.stringify({ stateFolder: box.stateFolder, record: box.record, version });
  const child = spawn(process.execPath, [program, dist, input], {
    env: childEnvironment(box.home),
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function note(box: Sandbox, event: string): HookNote {
  return {
    integration: "claude",
    event,
    sessionId: "s",
    transcriptPath: box.main,
    writer: { destinations: [], redact: false },
  };
}

function hook(box: Sandbox, sent: HookNote, startsWorker = true, version = VERSION): void {
  const start = () => (startsWorker ? startWorker(box, version) : undefined);
  sendHookNote(sent, { paths: box.paths, version, startWorker: start });
}

const isAlive = (pid: number) => processIsAlive(pid) !== false;
const lockPid = (lock: string): number => JSON.parse(readFileSync(lock, "utf8")).pid;
const mode = (path: string) => statSync(path).mode & 0o777;
const lines = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
const recorded = (box: Sandbox, count: number) =>
  waitFor(() => lines(box.record).length >= count && lines(box.record), "recorded events");
const startedWorkers = (box: Sandbox) =>
  lines(box.paths.log).filter((line) => line.includes(WORKER_STARTED_LOG)).length;
const transcriptLine = (uuid: string, extra: object = {}) =>
  `${JSON.stringify({ uuid, ...extra })}\n`;

it("delivers fifty simultaneous hooks through one worker when none is running", async () => {
  const box = sandbox();
  const events = Array.from({ length: 50 }, (_, index) => `Event${index}`);
  for (const event of events) hook(box, note(box, event));
  const received = await recorded(box, 50);
  expect(received.toSorted()).toEqual(events.map((event) => `s note ${event}`).toSorted());
  expect(startedWorkers(box)).toBe(1);
  await delay(TICK_MS * 2);
  expect(lines(box.record)).toHaveLength(50);
});

it("keeps a note written while no worker runs private and applies it in transcript order", async () => {
  const box = sandbox();
  writeFileSync(box.main, transcriptLine("L1") + transcriptLine("L2"));
  hook(box, note(box, "Stop"), false);
  expect([mode(box.paths.folder), mode(box.paths.notes)]).toEqual([0o700, 0o600]);
  appendFileSync(box.main, transcriptLine("L3"));
  startWorker(box);
  expect(await recorded(box, 4)).toEqual(["s line L1", "s line L2", "s note Stop", "s line L3"]);
});

it("reads lines between hooks and holds a Stop until the lines written before it are read", async () => {
  const box = sandbox();
  hook(box, note(box, "Start"));
  await recorded(box, 1);
  appendFileSync(box.main, transcriptLine("L1"));
  await recorded(box, 2);
  appendFileSync(box.main, transcriptLine("L2"));
  hook(box, note(box, "Stop"));
  expect(await recorded(box, 4)).toEqual(["s note Start", "s line L1", "s line L2", "s note Stop"]);
});

it("does not read subagent lines written after a Stop before the Stop", async () => {
  const box = sandbox();
  writeFileSync(box.main, transcriptLine("L1", { subagent: box.subagent }));
  writeFileSync(box.subagent, transcriptLine("S1"));
  hook(box, note(box, "Start"));
  await recorded(box, 3);
  appendFileSync(box.main, transcriptLine("L2"));
  const injection = { path: box.subagent, text: transcriptLine("S2") };
  writeFileSync(`${box.main}.inject`, JSON.stringify(injection));
  hook(box, note(box, "Stop"));
  expect((await recorded(box, 6)).slice(3)).toEqual(["s line L2", "s note Stop", "s line S2"]);
});

it("reads a subagent found during a read up to a note before delivering it", async () => {
  const box = sandbox();
  writeFileSync(box.main, transcriptLine("L1", { subagent: box.subagent }));
  writeFileSync(box.subagent, transcriptLine("S1"));
  hook(box, note(box, "Stop"));
  expect(await recorded(box, 3)).toEqual(["s line L1", "s line S1", "s note Stop"]);
});

it("takes a hook's note before reading a line written after it during the same read", async () => {
  const box = sandbox();
  hook(box, note(box, "Start"));
  await recorded(box, 1);
  const prompt = { note: note(box, "Prompt"), next: transcriptLine("L2") };
  appendFileSync(box.main, transcriptLine("L1", { hook: prompt }));
  expect(await recorded(box, 4)).toEqual([
    "s note Start",
    "s line L1",
    "s note Prompt",
    "s line L2",
  ]);
});

it("uploads each line with the settings of the note before it, not a newer one", async () => {
  const box = sandbox();
  hook(box, note(box, "Start"), false);
  writeFileSync(box.main, transcriptLine("L1", { posts: true }));
  hook(box, { ...note(box, "Prompt"), writer: { destinations: [], redact: true } }, false);
  startWorker(box);
  expect(await recorded(box, 4)).toContain("s post L1 redact false");
});

it("delivers a note whose transcript size fell in the middle of a line", async () => {
  const box = sandbox();
  hook(box, note(box, "Start"), false);
  appendFileSync(box.main, `${transcriptLine("L1")}{"uuid":`);
  hook(box, note(box, "Stop"), false);
  appendFileSync(box.main, '"L2"}\n');
  hook(box, note(box, "Next"));
  expect(await recorded(box, 5)).toEqual([
    "s note Start",
    "s line L1",
    "s note Stop",
    "s line L2",
    "s note Next",
  ]);
});

it("delivers a note whose transcript was deleted before it was read", async () => {
  const box = sandbox();
  writeFileSync(box.main, transcriptLine("L1"));
  hook(box, note(box, "Stop"), false);
  unlinkSync(box.main);
  startWorker(box);
  expect(await recorded(box, 1)).toEqual(["s note Stop"]);
});

it("exits once every session has ended or stopped its turn and removes its lock", async () => {
  const box = sandbox();
  hook(box, note(box, "Start"));
  hook(box, note(box, "SessionEnd"));
  hook(box, { ...note(box, "Stop"), sessionId: "t" });
  await recorded(box, 3);
  await waitFor(() => !existsSync(box.paths.lock), "the worker to exit");
});

it("pauses reading while the upload queue is full and reads every line once after", async () => {
  const box = sandbox();
  writeFileSync(`${box.record}.full`, "");
  writeFileSync(box.main, transcriptLine("L1") + transcriptLine("L2"));
  hook(box, note(box, "Start"));
  const saved = await waitFor(
    () => existsSync(box.paths.snapshot) && readFileSync(box.paths.snapshot, "utf8"),
  );
  expect(JSON.parse(saved).sessions.s.bookmarks[box.main].offset).toBe(0);
  expect(lines(box.record)).toEqual([]);
  unlinkSync(`${box.record}.full`);
  expect(await recorded(box, 3)).toEqual(["s line L1", "s line L2", "s note Start"]);
  await waitFor(
    () =>
      JSON.parse(readFileSync(box.paths.snapshot, "utf8")).sessions.s.bookmarks[box.main].offset >
      0,
  );
  expect(lines(box.record)).toHaveLength(3);
});

it("stops a read in progress once the upload queue fills", async () => {
  const box = sandbox();
  const big = transcriptLine("L1", { fillsQueue: true, pad: "x".repeat(1 << 20) });
  writeFileSync(box.main, big + transcriptLine("L2"));
  hook(box, note(box, "Start"));
  await recorded(box, 1);
  await delay(TICK_MS * 2);
  expect(lines(box.record)).toEqual(["s line L1"]);
  unlinkSync(`${box.record}.full`);
  expect(await recorded(box, 3)).toEqual(["s line L1", "s line L2", "s note Start"]);
});

it("saves no snapshot while a session still has uploads waiting", async () => {
  const box = sandbox();
  writeFileSync(`${box.record}.pending`, "");
  writeFileSync(box.main, transcriptLine("L1"));
  hook(box, note(box, "Start"));
  await recorded(box, 2);
  await delay(TICK_MS * 2);
  expect(existsSync(box.paths.snapshot)).toBe(false);
  unlinkSync(`${box.record}.pending`);
  await waitFor(() => existsSync(box.paths.snapshot));
});

it("runs the older-state upgrade once before taking any notes", async () => {
  const box = sandbox();
  hook(box, note(box, "Start"));
  await recorded(box, 1);
  expect(lines(`${box.record}.upgrades`)).toEqual(["notes waiting: true"]);
});

it("hands off from an older worker to the newer plugin's worker", async () => {
  const box = sandbox();
  const older = startWorker(box, "1.0.0");
  await waitFor(() => startedWorkers(box) === 1);
  hook(box, note(box, "Start"), true, "1.10.0");
  await once(older, "exit");
  const newer = await waitFor(
    () => existsSync(box.paths.lock) && JSON.parse(readFileSync(box.paths.lock, "utf8")),
  );
  expect(newer.version).toBe("1.10.0");
  await once(startWorker(box, "1.10.0"), "exit");
  hook(box, note(box, "FromOlderPlugin"), true, "1.9.0");
  expect(await recorded(box, 2)).toEqual(["s note Start", "s note FromOlderPlugin"]);
  await delay(TICK_MS * 2);
  expect(lockPid(box.paths.lock)).toBe(newer.pid);
});

const savedNotesOffset = (box: Sandbox): number | false =>
  existsSync(box.paths.snapshot) &&
  JSON.parse(readFileSync(box.paths.snapshot, "utf8")).notes.offset;

it("gives a saved session's builder its tracing mode", async () => {
  const box = sandbox();
  const session = { ...note(box, "Start"), bookmarks: {}, pendingNotes: [], tracingMode: "off" };
  hook(box, note(box, "Start"), false);
  writeFileSync(box.paths.snapshot, JSON.stringify({ version: 1, sessions: { s: session } }));
  startWorker(box);
  expect(await recorded(box, 2)).toEqual(["s mode off", "s note Start"]);
});

it("sets aside a session with no notes for a day and picks it up where it left off", async () => {
  const box = sandbox();
  const old = join(box.home, "old.jsonl");
  writeFileSync(old, transcriptLine("O1"));
  const saved = (sessionId: string, lastNoteAt?: number, transcriptPath = box.main) => ({
    ...note(box, "Start"),
    sessionId,
    transcriptPath,
    bookmarks: {
      [transcriptPath]: { path: transcriptPath, offset: statSync(transcriptPath).size },
    },
    pendingNotes: [],
    ended: false,
    lastNoteAt,
  });
  const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
  const sessions = {
    stale: saved("stale", dayAgo, old),
    s: saved("s", dayAgo),
    legacy: saved("legacy"),
  };
  hook(box, note(box, "Start"), false);
  writeFileSync(box.paths.snapshot, JSON.stringify({ version: 1, sessions }));
  startWorker(box);
  const savedSessions = () =>
    Object.keys(JSON.parse(readFileSync(box.paths.snapshot, "utf8")).sessions);
  await waitFor(() => !savedSessions().includes("stale"), "the snapshot to save");
  expect(savedSessions().toSorted()).toEqual(["legacy", "s"]);

  appendFileSync(old, transcriptLine("N1"));
  hook(box, { ...note(box, "Next"), sessionId: "stale", transcriptPath: old });
  await waitFor(() => lines(box.record).includes("stale line N1"), "the new line");
  expect(lines(box.record).filter((entry) => entry.startsWith("stale"))).toEqual([
    "stale line N1",
    "stale note Next",
  ]);
  const parked = () => JSON.parse(readFileSync(box.paths.snapshot, "utf8")).parked;
  await waitFor(() => !("stale" in parked()), "the resumed session to leave the parked list");
});

it("resumes from the saved notes offset after a restart without retaking old notes", async () => {
  const box = sandbox();
  hook(box, note(box, "Start"));
  await recorded(box, 1);
  await waitFor(() => savedNotesOffset(box) === readFileSync(box.paths.notes).length);
  const killed = lockPid(box.paths.lock);
  process.kill(killed, "SIGKILL");
  await waitFor(() => !isAlive(killed), "the worker to die");
  hook(box, note(box, "Next"));
  expect(await recorded(box, 2)).toEqual(["s note Start", "s note Next"]);
  await delay(TICK_MS * 2);
  expect(lines(box.record)).toHaveLength(2);
});

it("does not exit while a note is still being written", async () => {
  const box = sandbox();
  hook(box, note(box, "Start"));
  hook(box, note(box, "SessionEnd"));
  await recorded(box, 2);
  const late = `${JSON.stringify({ ...note(box, "Late"), transcriptSizes: {} })}\n`;
  appendFileSync(box.paths.notes, late.slice(0, 10));
  await delay(IDLE_EXIT_MS + TICK_MS * 3);
  expect(existsSync(box.paths.lock)).toBe(true);
  expect(lines(box.paths.log).filter((line) => /resumed|stopped/u.test(line))).toEqual([]);
  appendFileSync(box.paths.notes, late.slice(10));
  expect(await recorded(box, 3)).toEqual(["s note Start", "s note SessionEnd", "s note Late"]);
});
