const fs = await import("node:fs");
const dist = process.argv[2];
const { runWorker } = await import(`${dist}/worker/worker.js`);
const { readNewLines } = await import(`${dist}/reader/reader.js`);
const { tracerPaths } = await import(`${dist}/paths.js`);
const { stateFolder, record, version } = JSON.parse(process.argv[3]);
const paths = tracerPaths(stateFolder);
const write = (entry) => fs.appendFileSync(record, `${entry}\n`);

function injectWrite(bookmark) {
  const injection = `${bookmark.path}.inject`;
  if (!fs.existsSync(injection)) return;
  const { path, text } = JSON.parse(fs.readFileSync(injection, "utf8"));
  fs.appendFileSync(path, text);
  fs.unlinkSync(injection);
}

const credentials = {
  destinations: [{ apiKey: "lsv2_worker_key", apiUrl: "https://example.test", projectName: "p" }],
  replicas: [{ apiKey: "lsv2_worker_replica_key", apiUrl: "https://replica.test" }],
  redact: false,
};

await runWorker({
  paths,
  version,
  credentials,
  upgradeState: () =>
    fs.appendFileSync(`${record}.upgrades`, `notes waiting: ${fs.existsSync(paths.notes)}\n`),
  readNewLines: (bookmark, lineId) => {
    injectWrite(bookmark);
    return readNewLines(bookmark, lineId).lines;
  },
  createBuilder: ({ sessionId, tracingMode, sink }) => {
    if (tracingMode !== undefined) write(`${sessionId} mode ${tracingMode}`);
    const subagents = new Set();
    return {
      lineId: (line) => line.uuid,
      readLine: (path, line) => {
        write(`${sessionId} line ${line.uuid}`);
        if (line.subagent) subagents.add(line.subagent);
        if (line.fillsQueue) fs.writeFileSync(`${record}.full`, "");
        if (line.posts) sink.post({ id: line.uuid });
        if (line.hook) {
          const { note, next } = line.hook;
          const transcriptSizes = { [note.transcriptPath]: fs.statSync(note.transcriptPath).size };
          fs.appendFileSync(paths.notes, `${JSON.stringify({ ...note, transcriptSizes })}\n`);
          fs.appendFileSync(note.transcriptPath, next);
        }
      },
      receiveNote: (note) => write(`${sessionId} note ${note.event}`),
      transcripts: () => [...subagents],
      turnOpen: () => !fs.readFileSync(record, "utf8").includes(`${sessionId} note Stop`),
      state: () => ({}),
    };
  },
  createQueue: () => ({
    post: (sessionId, writer, run) => {
      const keys = [writer.destinations[0]?.apiKey, writer.replicas?.[0]?.apiKey].filter(Boolean);
      write(
        `${sessionId} post ${run.id} redact ${writer.redact}${keys.map((key) => ` key ${key}`).join("")}`,
      );
    },
    patch: () => undefined,
    pendingFor: () => (fs.existsSync(`${record}.pending`) ? 1 : 0),
    idle: () => true,
    full: () => fs.existsSync(`${record}.full`),
    flush: () => undefined,
  }),
  snapshots: {
    load: () =>
      fs.existsSync(paths.snapshot)
        ? JSON.parse(fs.readFileSync(paths.snapshot, "utf8"))
        : undefined,
    save: (snapshot) => {
      fs.writeFileSync(`${paths.snapshot}.tmp`, JSON.stringify(snapshot));
      fs.renameSync(`${paths.snapshot}.tmp`, paths.snapshot);
    },
  },
});
process.exit(0);
