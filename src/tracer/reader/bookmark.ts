import { readSync } from "node:fs";
import type { Bookmark, LineIdReader } from "../types.js";
import { parseLine, scanLines } from "./lines.js";
import { BOOKMARK_CHECK_BYTES, NEWLINE } from "../constants.js";

export function recoverBookmark(
  file: number,
  size: number,
  bookmark: Bookmark,
  lineId: LineIdReader,
  notices: string[],
): void {
  if (bookmark.offset === 0) return;
  const id = bookmark.lastLineId;
  if (id === undefined) {
    if (bookmark.offset <= size) return;
    bookmark.offset = 0;
    notices.push(
      `${bookmark.path} shrank and has no line ID to resume from, reading from the start`,
    );
    return;
  }
  if (bookmark.offset <= size && lastIdEndingAt(file, bookmark.offset, lineId) === id) return;
  const end = findLineEnd(file, size, id, lineId);
  if (end === undefined) {
    bookmark.offset = 0;
    notices.push(`line ${id} is gone from ${bookmark.path}, reading from the start`);
    return;
  }
  bookmark.offset = end;
  notices.push(`${bookmark.path} changed, resuming after line ${id} at byte ${end}`);
}

function idOf(text: Buffer, lineId: LineIdReader): string | undefined {
  const line = parseLine(text.toString("utf8"));
  return line === undefined ? undefined : lineId(line);
}

function lastIdEndingAt(file: number, offset: number, lineId: LineIdReader): string | undefined {
  const last = Buffer.alloc(1);
  if (offset === 0 || readSync(file, last, 0, 1, offset - 1) !== 1 || last[0] !== NEWLINE)
    return undefined;
  let end = offset - 1;
  let rest = Buffer.alloc(0);
  for (;;) {
    const start = Math.max(0, end - BOOKMARK_CHECK_BYTES);
    const chunk = Buffer.alloc(end - start);
    readSync(file, chunk, 0, chunk.length, start);
    let text = Buffer.concat([chunk, rest]);
    for (let cut = text.lastIndexOf(NEWLINE); cut !== -1; cut = text.lastIndexOf(NEWLINE)) {
      const id = idOf(text.subarray(cut + 1), lineId);
      if (id !== undefined) return id;
      text = text.subarray(0, cut);
    }
    if (start === 0) return idOf(text, lineId);
    rest = text;
    end = start;
  }
}

function findLineEnd(
  file: number,
  size: number,
  id: string,
  lineId: LineIdReader,
): number | undefined {
  let found: number | undefined;
  scanLines(file, 0, size, (text, end) => {
    if (!text.includes(id)) return false;
    const line = parseLine(text);
    if (line === undefined || lineId(line) !== id) return false;
    found = end;
    return true;
  });
  return found;
}
