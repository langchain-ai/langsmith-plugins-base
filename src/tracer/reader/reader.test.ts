import { appendFileSync, fstatSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Bookmark, TranscriptLine } from "../types.js";
import { readNewLines } from "./reader.js";

vi.mock("node:fs", { spy: true });
const realFstat = (await vi.importActual<typeof import("node:fs")>("node:fs")).fstatSync;
const noInode = (file: number) => ({ ...realFstat(file, { bigint: true }), ino: 0n }) as never;

const lineId = (line: TranscriptLine) => (typeof line.uuid === "string" ? line.uuid : undefined);
const entry = (uuid: string, padding = "") => `${JSON.stringify({ uuid, padding })}\n`;

function transcript(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "tracer reader ")), "session.jsonl");
  writeFileSync(path, contents);
  return path;
}

function readOnce(contents: string): Bookmark {
  const bookmark: Bookmark = { path: transcript(contents), offset: 0 };
  readAll(bookmark);
  return bookmark;
}

function readAll(bookmark: Bookmark): { ids: unknown[]; notices: string[]; calls: number } {
  const ids: unknown[] = [];
  const notices: string[] = [];
  let calls = 0;
  let reachedEnd = false;
  while (!reachedEnd) {
    const read = readNewLines(bookmark, lineId);
    ids.push(...read.lines.map(({ line }) => line.uuid));
    notices.push(...read.notices);
    reachedEnd = read.reachedEnd;
    calls += 1;
  }
  return { ids, notices, calls };
}

it("never loses or duplicates a line while the transcript is appended in fragments", () => {
  const path = transcript("");
  const bookmark: Bookmark = { path, offset: 0 };
  const expected = Array.from({ length: 200 }, (_, index) => `line-${index}`);
  const text = expected.map((uuid) => entry(uuid)).join("");
  const seen: unknown[] = [];
  for (let at = 0; at < text.length; at += 37) {
    appendFileSync(path, text.slice(at, at + 37));
    seen.push(...readAll(bookmark).ids);
  }
  expect(seen).toEqual(expected);
  expect(bookmark).toEqual({ path, offset: Buffer.byteLength(text), lastLineId: "line-199" });
});

it("reads a large transcript in bounded pieces without losing a line at a piece boundary", () => {
  const expected = Array.from({ length: 300 }, (_, index) => `big-${index}`);
  const path = transcript(expected.map((uuid) => entry(uuid, "x".repeat(10_000))).join(""));
  const { ids, calls } = readAll({ path, offset: 0 });
  expect(ids).toEqual(expected);
  expect(calls).toBeGreaterThan(2);
});

it("leaves a partial last line for the next read and returns it once it is complete", () => {
  const path = transcript(`${entry("a")}{"uuid":"b"`);
  const bookmark: Bookmark = { path, offset: 0 };
  expect(readAll(bookmark).ids).toEqual(["a"]);
  appendFileSync(path, `}\n`);
  expect(readAll(bookmark).ids).toEqual(["b"]);
});

it("skips and reports an unreadable line and keeps the lines after it", () => {
  const path = transcript(`${entry("a")}not json\n\n${entry("b")}`);
  const { ids, notices } = readAll({ path, offset: 0 });
  expect(ids).toEqual(["a", "b"]);
  expect(notices).toEqual([`skipped an unreadable line ending at byte 35 of ${path}`]);
});

it("resumes after the right line by id when the transcript was rewritten smaller", () => {
  const bookmark = readOnce(
    ["a", "b", "c", "d"].map((uuid) => entry(uuid, "y".repeat(50))).join(""),
  );
  const { path } = bookmark;
  writeFileSync(path, `{"uuid": "b"}\n{"uuid": "c"}\n{"uuid": "d"}\n{"uuid": "e"}\n`);
  const { ids, notices } = readAll({ ...bookmark });
  expect(ids).toEqual(["e"]);
  expect(notices).toEqual([`${path} changed, resuming after line d at byte 42`]);
});

it("reads every line again when a live transcript is replaced, or rewritten where files have no inode", () => {
  const bookmark = readOnce(`${entry("a")}${entry("b")}`);
  const { path } = bookmark;
  writeFileSync(`${path}.new`, `${entry("z", "x".repeat(100))}${entry("y")}`);
  renameSync(`${path}.new`, path);
  expect(readAll(bookmark).ids).toEqual(["z", "y"]);
  vi.mocked(fstatSync).mockImplementation(noInode);
  readAll(bookmark);
  writeFileSync(path, `${entry("w", "x".repeat(200))}${entry("v")}`);
  expect(readAll(bookmark).ids).toEqual(["w", "v"]);
  vi.mocked(fstatSync).mockRestore();
});

it("resumes after the right line by id when a restarted worker finds the lines shifted", () => {
  const bookmark = readOnce(`${entry("a")}${entry("b")}`);
  writeFileSync(bookmark.path, `${entry("b")}${entry("new-1")}${entry("new-2")}${entry("new-3")}`);
  expect(readAll({ ...bookmark }).ids).toEqual(["new-1", "new-2", "new-3"]);
});

it("starts from the beginning and says so when the line id is gone", () => {
  const bookmark = readOnce(`${entry("a")}${entry("b")}`);
  writeFileSync(bookmark.path, entry("z"));
  const { ids, notices } = readAll({ ...bookmark });
  expect(ids).toEqual(["z"]);
  expect(notices).toEqual([`line b is gone from ${bookmark.path}, reading from the start`]);
});

it("does not re-read lines without an id that followed the last id after a restart", () => {
  const bookmark = readOnce(`${entry("a")}{"type":"summary"}\n`);
  appendFileSync(bookmark.path, entry("b"));
  expect(readAll({ ...bookmark })).toMatchObject({ ids: ["b"], notices: [] });
});
