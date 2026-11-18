import { closeSync, existsSync, fstatSync, openSync } from "node:fs";
import type { Bookmark, ReadLine, LineIdReader, TranscriptRead } from "../types.js";
import { recoverBookmark } from "./bookmark.js";
import { parseLine, scanLines } from "./lines.js";
import { READ_CHUNK_BYTES } from "../constants.js";

const checkedInodes = new WeakMap<Bookmark, bigint>();

export function readNewLines(bookmark: Bookmark, lineId: LineIdReader): TranscriptRead {
  const lines: ReadLine[] = [];
  const notices: string[] = [];
  if (!existsSync(bookmark.path)) return { lines, notices, reachedEnd: true };
  const file = openSync(bookmark.path, "r");
  try {
    const { size: bigSize, ino } = fstatSync(file, { bigint: true });
    const size = Number(bigSize);
    if (size < bookmark.offset || ino === 0n || checkedInodes.get(bookmark) !== ino) {
      recoverBookmark(file, size, bookmark, lineId, notices);
      checkedInodes.set(bookmark, ino);
    }
    const start = bookmark.offset;
    let reachedEnd = true;
    bookmark.offset = scanLines(file, start, size, (text, end) => {
      const line = parseLine(text);
      if (line !== undefined) {
        lines.push({ line, end });
        const id = lineId(line);
        if (id !== undefined) bookmark.lastLineId = id;
      } else if (text.toString("utf8").trim() !== "") {
        notices.push(`skipped an unreadable line ending at byte ${end} of ${bookmark.path}`);
      }
      reachedEnd = end - start < READ_CHUNK_BYTES;
      return !reachedEnd;
    });
    return { lines, notices, reachedEnd };
  } finally {
    closeSync(file);
  }
}
