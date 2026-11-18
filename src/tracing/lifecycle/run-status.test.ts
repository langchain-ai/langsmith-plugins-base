import { describe, expect, it } from "vitest";
import { RUN_ID } from "../../test-support/constants.js";
import { projectSubmission } from "./projection.js";

const RUN = {
  id: RUN_ID,
  name: "root run",
  run_type: "chain",
  start_time: "2026-10-09T20:00:00.000Z",
  inputs: { prompt: "p" },
};
const METADATA = {
  integration: "openai-codex",
  threadId: "thread-1",
  turnId: "turn-1",
  agentType: "root",
  runType: "root",
};

function post(privacyMode: "full" | "metadata", status: unknown) {
  return projectSubmission(
    {
      operation: "post",
      integration: "openai-codex",
      privacyMode,
      run: { ...RUN, end_time: "2026-10-09T20:00:01.000Z", status },
      metadata: METADATA,
    },
    "openai-codex",
  );
}

function patch(privacyMode: "full" | "metadata", status: unknown) {
  return projectSubmission(
    {
      operation: "patch",
      integration: "openai-codex",
      privacyMode,
      run: {
        id: RUN_ID,
        name: "root run",
        run_type: "chain",
        start_time: RUN.start_time,
        trace_id: RUN_ID,
        dotted_order: `20261009T200000000Z${RUN_ID}`,
      },
      privacyContext: { status: "completed" },
      patch: { fields: ["end_time", "status"], values: { end_time: RUN.start_time, status } },
      metadata: METADATA,
    },
    "openai-codex",
  );
}

function payloadOf(result: ReturnType<typeof projectSubmission>) {
  if (result.status !== "ready") throw new Error("expected a ready submission");
  return result.value.payload as unknown as {
    run: { status?: string };
    patch: { fields: string[]; values: { status?: string } };
  };
}

describe("run status projection", () => {
  for (const mode of ["full", "metadata"] as const) {
    it(`keeps an explicit status on a post and a patch in ${mode} mode`, () => {
      expect(payloadOf(post(mode, "cancelled")).run.status).toBe("cancelled");
      const projected = payloadOf(patch(mode, "interrupted")).patch;
      expect(projected.fields).toContain("status");
      expect(projected.values.status).toBe("interrupted");
    });

    it(`drops an unknown status instead of throwing in ${mode} mode`, () => {
      expect(payloadOf(post(mode, "bogus")).run).not.toHaveProperty("status");
      const projected = payloadOf(patch(mode, "success")).patch;
      expect(projected.fields).not.toContain("status");
      expect(projected.values).not.toHaveProperty("status");
    });
  }
});
