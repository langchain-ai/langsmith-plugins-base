import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const uploadClosedTurn = `const id = crypto.randomUUID();
const body = { post: [{ id, trace_id: id, start_time: 1, end_time: 2 }] };
await fetch(process.env.LANGSMITH_ENDPOINT + "/runs/batch", { method: "POST", body: JSON.stringify(body) });
`;

function transcript(turns: number): string {
  return Array.from({ length: turns }, (_, turn) =>
    [
      { type: "user", sessionId: "s", message: { content: `prompt ${turn}` } },
      { type: "assistant", message: { id: `m${turn}`, stop_reason: "end_turn", content: [] } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  ).join("\n");
}

const uploadTurnOnFirstStop = `import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(0, "utf8"));
if (!payload.stop_hook_active) {
${uploadClosedTurn}}
`;

function replayWithStopHook(session: string, stopScript: string, timeoutMs: string): string {
  const root = mkdtempSync(join(tmpdir(), "replay-stop-"));
  mkdirSync(join(root, "plugin", "hooks"), { recursive: true });
  mkdirSync(join(root, "sessions"));
  writeFileSync(join(root, "plugin", "stop.mjs"), stopScript);
  const hooks = { Stop: [{ hooks: [{ command: `node "${join(root, "plugin", "stop.mjs")}"` }] }] };
  writeFileSync(join(root, "plugin", "hooks", "hooks.json"), JSON.stringify({ hooks }));
  writeFileSync(join(root, "sessions", "session.jsonl"), session);
  const script = join(import.meta.dirname, "replay.ts");
  const args = ["--agent", "claude", "--plugin", join(root, "plugin"), "--session-timeout-ms"];
  return spawnSync(
    process.execPath,
    [script, ...args, timeoutMs, "--sessions", join(root, "sessions")],
    {
      encoding: "utf8",
    },
  ).stdout;
}

describe("replay", () => {
  it("stops a session past its time limit and still replays the next one", () => {
    const root = mkdtempSync(join(tmpdir(), "replay-timeout-"));
    mkdirSync(join(root, "plugin", "hooks"), { recursive: true });
    const sessions = join(root, "sessions");
    mkdirSync(sessions);
    writeFileSync(join(root, "plugin", "stop.mjs"), uploadClosedTurn);
    const hooks = {
      UserPromptSubmit: [{ hooks: [{ command: "sleep 0.4" }] }],
      Stop: [{ hooks: [{ command: `node "${join(root, "plugin", "stop.mjs")}"` }] }],
    };
    writeFileSync(join(root, "plugin", "hooks", "hooks.json"), JSON.stringify({ hooks }));
    writeFileSync(join(sessions, "a-long.jsonl"), transcript(6));
    writeFileSync(join(sessions, "b-short.jsonl"), transcript(1));
    const script = join(import.meta.dirname, "replay.ts");
    const args = ["--agent", "claude", "--plugin", join(root, "plugin"), "--session-timeout-ms"];
    const replay = spawnSync(process.execPath, [script, ...args, "1000", "--sessions", sessions], {
      encoding: "utf8",
    });
    expect(replay.stdout).toContain("TIMEOUT a-long.jsonl after 1000 ms");
    expect(replay.stdout).toMatch(/(PASS|FAIL) b-short\.jsonl/);
    expect(replay.stdout).toContain("1 timed out");
  }, 30_000);

  it("does not wait for a new turn when a Stop hook continues the running one", () => {
    const lines = [
      { type: "user", sessionId: "s", message: { content: "prompt" } },
      { type: "assistant", message: { id: "m1", stop_reason: "end_turn", content: [] } },
      { type: "attachment", attachment: { type: "hook_additional_context", hookEvent: "Stop" } },
      { type: "assistant", message: { id: "m2", stop_reason: "end_turn", content: [] } },
    ];
    const session = lines.map((line) => JSON.stringify(line)).join("\n");
    const stdout = replayWithStopHook(session, uploadTurnOnFirstStop, "10000");
    expect(stdout).not.toContain("TIMEOUT");
  }, 30_000);

  it("replays a finished session whose only turn starts without a prompt", () => {
    const reply = { id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
    const session = JSON.stringify({ type: "assistant", sessionId: "s", message: reply });
    const stdout = replayWithStopHook(session, uploadClosedTurn, "10000");
    expect(stdout).not.toContain("SKIP");
    expect(stdout).toMatch(/(PASS|FAIL) session\.jsonl/);
  }, 30_000);
});
