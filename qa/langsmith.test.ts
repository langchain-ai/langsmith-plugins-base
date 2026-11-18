import { describe, expect, it } from "vitest";
import { turnUploaded } from "./langsmith.ts";
import type { TracedRun } from "./models.ts";

function root(id: string, ended: boolean): TracedRun {
  const start_time = `2026-01-01T00:00:0${id}.000Z`;
  const fields = { name: "turn", run_type: "chain", parent_run_id: null, inputs: {}, outputs: {} };
  return { id, trace_id: id, start_time, end_time: ended ? start_time : null, ...fields };
}

describe("turnUploaded", () => {
  it("stops waiting once the newest turn closes even while an older one stays open", () => {
    expect(turnUploaded([root("2", true), root("1", false)], 2)).toBe(true);
    expect(turnUploaded([root("1", true), root("2", false)], 2)).toBe(false);
    expect(turnUploaded([root("2", true), root("1", false)], 3)).toBe(false);
  });
});
