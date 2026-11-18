import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { describe } from "../../utils/errors.js";
import { NOTES_FILE_MODE, TRACER_FOLDER_MODE, HOOK_WARNING_PREFIX } from "../constants.js";
import type { HookNote, PositionedHookNote } from "../types.js";
import type { HookClientOptions, StopWorkerRequest } from "../types.js";
import { withoutCredentials } from "./credentials.js";
import { isNewerVersion, liveLockHolder } from "./lock.js";

function positioned(note: HookNote): PositionedHookNote {
  const path = note.transcriptPath;
  const size = path === undefined ? undefined : statSync(path, { throwIfNoEntry: false })?.size;
  const transcriptSizes = path !== undefined && size !== undefined ? { [path]: size } : {};
  return { ...note, transcriptSizes };
}

export function sendHookNote(note: HookNote, options: HookClientOptions): void {
  const { paths, version, startWorker } = options;
  try {
    mkdirSync(paths.folder, { recursive: true, mode: TRACER_FOLDER_MODE });
    const line = JSON.stringify(positioned({ ...note, writer: withoutCredentials(note.writer) }));
    appendFileSync(paths.notes, `${line}\n`, { mode: NOTES_FILE_MODE });
    const holder = liveLockHolder(paths.lock);
    if (holder === undefined) startWorker();
    else if (isNewerVersion(version, holder.version)) {
      const request: StopWorkerRequest = { stopWorker: true, version };
      appendFileSync(paths.notes, `${JSON.stringify(request)}\n`, { mode: NOTES_FILE_MODE });
      startWorker();
    }
  } catch (error) {
    process.stderr.write(`${HOOK_WARNING_PREFIX}${describe(error)}\n`);
  }
}
