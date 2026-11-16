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
});
