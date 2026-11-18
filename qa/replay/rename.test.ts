import { describe, expect, it } from "vitest";
import { renamedTurns } from "./rename.ts";

function rename(text: string): string {
  return text.replaceAll("s-old", "s-new");
}

describe("renamedTurns", () => {
  it("expects the fresh session id wherever a prompt or reply quoted the old one", () => {
    const turn = { prompt: "open s-old", command: "", minTools: 0, reply: "saved s-old" };
    expect(renamedTurns([turn, { ...turn, reply: null }], rename)).toEqual([
      { prompt: "open s-new", command: "", minTools: 0, reply: "saved s-new" },
      { prompt: "open s-new", command: "", minTools: 0, reply: null },
    ]);
  });
});
