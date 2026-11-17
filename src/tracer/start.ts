import type { StartTracerOptions, UploadQueue } from "./models.js";
import { readNewLines } from "./reader/reader.js";
import { upgradeLegacyState } from "./snapshot/legacy.js";
import { loadSnapshot, writeSnapshot } from "./snapshot/snapshot.js";
import { createUploadQueue } from "./upload-queue/upload-queue.js";
import { tracerPaths } from "./paths.js";
import { runWorker } from "./worker/worker.js";

export function startTracerWorker(options: StartTracerOptions): Promise<void> {
  const paths = tracerPaths(options.agentStateFolder);
  let upgrading = Promise.resolve();
  return runWorker({
    paths,
    version: options.version,
    createBuilder: options.createBuilder,
    createQueue: (log): UploadQueue => createUploadQueue(log),
    readNewLines: (bookmark, lineId, log) => {
      const read = readNewLines(bookmark, lineId);
      for (const notice of read.notices) log(notice);
      return read.lines;
    },
    snapshots: {
      load: () => loadSnapshot(paths.snapshot).snapshot,
      save: (snapshot) => writeSnapshot(paths.snapshot, snapshot),
    },
    upgradeState: (log) => {
      upgrading = upgradeLegacyState(options, log);
    },
  }).then(() => upgrading);
}
