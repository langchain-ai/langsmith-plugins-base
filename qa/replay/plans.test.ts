import { describe, expect, it, vi } from "vitest";
import { claudePlan } from "./claude-plan.ts";
import { TOOL_START_EVENT } from "../constants.ts";
import { codexPlan } from "./codex-plan.ts";

const claudeTranscript = [
  { type: "user", sessionId: "s1", message: { role: "user", content: "list files" } },
  {
    type: "assistant",
    message: {
      id: "m1",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
  },
  {
    type: "assistant",
    message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "One file." }] },
  },
  { type: "user", message: { content: "<command-name>/clear</command-name>" } },
  { type: "user", message: { content: "<local-command-stdout></local-command-stdout>" } },
  { type: "user", message: { content: "<system-reminder>\nnote\n</system-reminder>\nthanks" } },
  {
    type: "assistant",
    message: { id: "m3", stop_reason: "end_turn", content: [{ type: "text", text: "Sure." }] },
  },
  { type: "user", message: { content: "<bash-input>ls</bash-input>" } },
];

const codexRollout = [
  { type: "session_meta", payload: { session_id: "c1", source: "cli" } },
  { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { type: "event_msg", payload: { type: "user_message", message: "list files" } },
  {
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "k1",
      name: "exec_command",
      arguments: '{"cmd":"ls"}',
    },
  },
  {
    type: "response_item",
    payload: { type: "function_call_output", call_id: "k1", output: "a.txt" },
  },
  {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "One file." },
  },
];

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function said(seconds: number, content: string) {
  return { type: "user", timestamp: at(seconds), message: { content } };
}

function toolCalls(seconds: number, ...uses: Record<string, unknown>[]) {
  const content = uses.map((use) => ({ type: "tool_use", input: {}, ...use }));
  return { type: "assistant", timestamp: at(seconds), message: { content } };
}

function toolResults(seconds: number, ids: string[], toolUseResult?: Record<string, unknown>) {
  const content = ids.map((id) => ({ type: "tool_result", tool_use_id: id }));
  return { type: "user", timestamp: at(seconds), toolUseResult, message: { content } };
}

function jsonLines(transcript: unknown[]): string[] {
  return transcript.map((line) => JSON.stringify(line));
}

function codexUserMessage(...texts: string[]) {
  const content = texts.map((text) => ({ type: "input_text", text }));
  return { type: "response_item", payload: { type: "message", role: "user", content } };
}

describe("claudePlan", () => {
  it("expects one turn per real prompt with its tools and reply", () => {
    expect(claudePlan(claudeTranscript).turns).toEqual([
      {
        prompt: "list files",
        command: "",
        minTools: 1,
        maxTools: 1,
        reply: "One file.",
        expectsModelCall: true,
      },
      {
        prompt: "thanks",
        command: "",
        minTools: 0,
        maxTools: 0,
        reply: "Sure.",
        expectsModelCall: true,
      },
      { prompt: "ls", command: "", minTools: 0, maxTools: 0, reply: null, expectsModelCall: false },
    ]);
  });

  it("fires the prompt hook before the prompt reaches the transcript", () => {
    const prompt = claudePlan(claudeTranscript).events.find(
      (event) => event.payload.hook_event_name === "UserPromptSubmit",
    );
    expect(prompt?.transcriptLines).toBe(0);
  });

  it("does not carry a reply over from the previous turn", () => {
    const interrupted = [
      ...claudeTranscript.slice(0, 4),
      { type: "user", message: { content: "and again" } },
      {
        type: "assistant",
        message: { id: "m4", stop_reason: "end_turn", content: [] },
      },
    ];
    const stops = claudePlan(interrupted).events.filter(
      (event) => event.payload.hook_event_name === "Stop",
    );
    expect(stops.map((event) => event.payload.last_assistant_message)).toEqual(["One file.", ""]);
  });

  it("ignores subagent lines when reading the main thread", () => {
    const withSubagent = [
      claudeTranscript[0]!,
      { type: "user", isSidechain: true, message: { content: "subagent prompt" } },
      {
        type: "assistant",
        isSidechain: true,
        message: { id: "s1", stop_reason: "end_turn", content: [{ type: "text", text: "Sub." }] },
      },
      claudeTranscript[3]!,
    ];
    expect(claudePlan(withSubagent).turns.map((turn) => [turn.prompt, turn.reply])).toEqual([
      ["list files", "One file."],
    ]);
  });

  it("ends the turn only after the last line of a split message", () => {
    const split = [
      claudeTranscript[0]!,
      {
        type: "assistant",
        message: {
          id: "m2",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Part one." }],
        },
      },
      {
        type: "assistant",
        message: {
          id: "m2",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Part two." }],
        },
      },
    ];
    const stops = claudePlan(split).events.filter(
      (event) => event.payload.hook_event_name === "Stop",
    );
    expect(
      stops.map((event) => [event.transcriptLines, event.payload.last_assistant_message]),
    ).toEqual([[3, "Part two."]]);
  });

  it("expects a turn for a message from another session but not for other meta lines", () => {
    const peer = [
      { type: "user", isMeta: true, message: { content: "skill instructions" } },
      {
        type: "user",
        isMeta: true,
        origin: { kind: "peer" },
        message: { content: "message from a peer" },
      },
      claudeTranscript[3]!,
    ];
    expect(claudePlan(peer).turns.map((turn) => [turn.prompt, turn.reply])).toEqual([
      ["message from a peer", "One file."],
    ]);
  });

  it("leaves skill calls out of the expected tool count", () => {
    const skill = [
      claudeTranscript[0]!,
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "k1", name: "Skill", input: { skill: "notes" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "k1", content: "loaded" }] },
      },
      claudeTranscript[3]!,
    ];
    expect(claudePlan(skill).turns[0]?.minTools).toBe(0);
  });

  it("reports a failed tool call as a failure", () => {
    const failed = [
      ...claudeTranscript.slice(0, 2),
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }],
        },
      },
    ];
    const names = claudePlan(failed).events.map((event) => event.payload.hook_event_name);
    expect(names).toContain("PostToolUseFailure");
    expect(names).not.toContain("PostToolUse");
  });

  it("fires the compaction hooks around a compaction", () => {
    const compacted = [
      { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual" } },
      { type: "user", isCompactSummary: true, message: { content: "summary" } },
    ];
    expect(
      claudePlan(compacted).events.map((event) => [
        event.payload.hook_event_name,
        event.payload.trigger,
      ]),
    ).toEqual([
      ["SessionStart", "manual"],
      ["PreCompact", "manual"],
      ["PostCompact", "auto"],
      ["SessionEnd", "auto"],
    ]);
  });

  it("expects no turn for a local command whose output is logged as a system line", () => {
    const plan = claudePlan([
      {
        type: "user",
        sessionId: "s1",
        message: { content: "<command-name>/usage</command-name>" },
      },
      { type: "system", subtype: "local_command", content: "<local-command-stdout>" },
      { type: "user", message: { content: "thanks" } },
      { type: "assistant", message: { id: "m1", stop_reason: "end_turn", content: [] } },
    ]);
    expect(plan.turns.map((turn) => turn.prompt)).toEqual(["thanks"]);
  });

  it("expects no turn for a notice Claude Code only writes to the transcript", () => {
    const notice = { type: "user", queueTranscriptOnly: true, message: { content: "done" } };
    const plan = claudePlan([{ ...notice, sessionId: "s1" }, ...claudeTranscript.slice(0, 4)]);
    expect(plan.turns.map((turn) => turn.prompt)).toEqual(["list files"]);
  });

  it("expects a slash command and a shell command as they were typed", () => {
    const done = { type: "assistant", message: { id: "m1", stop_reason: "end_turn", content: [] } };
    const command =
      "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>42</command-args>";
    const plan = claudePlan([
      { type: "user", sessionId: "s1", message: { content: command } },
      done,
      {
        type: "user",
        message: { content: "<bash-input> ls </bash-input><bash-stdout>a</bash-stdout>" },
      },
      { ...done, message: { ...done.message, id: "m2" } },
    ]);
    expect(plan.turns.map((turn) => turn.prompt)).toEqual(["/review 42", "ls"]);
  });

  it("expects a turn for a prompt Claude Code submits itself", () => {
    const scheduled = {
      type: "user",
      isMeta: true,
      turnPosition: {},
      message: { content: "tick" },
    };
    const plan = claudePlan([{ ...scheduled, sessionId: "s1" }, claudeTranscript[3]!]);
    expect(plan.turns.map((turn) => [turn.prompt, turn.reply])).toEqual([["tick", "One file."]]);
  });

  it("keeps a turn going when Claude Code continues it after its reply", () => {
    const continued = [
      ...claudeTranscript.slice(0, 4),
      { type: "user", isMeta: true, turnCompanion: true, message: { content: "check it" } },
      ...claudeTranscript.slice(1, 3),
      { type: "assistant", message: { id: "m5", stop_reason: "end_turn", content: [] } },
    ];
    const plan = claudePlan(continued);
    const stops = plan.events.filter((event) => event.payload.hook_event_name === "Stop");
    expect([plan.turns.length, plan.turns[0]?.minTools, stops.length]).toEqual([1, 2, 1]);
  });

  it("expects a task notification's summary as its prompt", () => {
    const notice =
      "<task-notification>\n<task-id>b1</task-id>\n<summary> Build finished </summary>";
    const plan = claudePlan([{ type: "user", sessionId: "s1", message: { content: notice } }]);
    expect(plan.turns.map((turn) => turn.prompt)).toEqual(["Build finished"]);
  });

  it("replays a subagent's hooks before its Agent call finishes", () => {
    const launched = [
      { type: "user", sessionId: "s1", message: { content: "explore" } },
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [
            { type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "Explore" } },
          ],
        },
      },
      {
        type: "user",
        toolUseResult: { agentId: "x1" },
        message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "done" }] },
      },
      {
        type: "assistant",
        message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
      },
    ];
    const subagent = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }] },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "found" }] } },
    ];
    const subagentLines = subagent.map((line) => JSON.stringify(line));
    const plan = claudePlan(launched, new Map([["x1", subagentLines]]));
    expect(plan.subagents).toEqual([
      { agentId: "x1", toolUseId: "a1", agentType: "Explore", lines: subagentLines },
    ]);
    expect(
      plan.events.map((event) => [
        event.payload.hook_event_name,
        event.agentId,
        event.payload.agent_type,
        event.transcriptLines,
      ]),
    ).toEqual([
      ["SessionStart", undefined, undefined, 0],
      ["UserPromptSubmit", undefined, undefined, 0],
      ["PreToolUse", undefined, undefined, 2],
      ["PreToolUse", "x1", "Explore", 1],
      ["PostToolUse", "x1", "Explore", 2],
      ["SubagentStop", "x1", "Explore", 3],
      ["PostToolUse", undefined, undefined, 3],
      ["Stop", undefined, undefined, 4],
      ["SessionEnd", undefined, undefined, 4],
    ]);
    expect(plan.events[5]?.payload.last_assistant_message).toBe("found");
    expect(plan.turns[0]?.minTools).toBe(2);
  });

  it("replays a background subagent alongside the main thread by time", () => {
    const launched = [
      { ...said(0, "explore"), sessionId: "s1" },
      toolCalls(1, { id: "b1", name: "Task" }),
      toolResults(2, ["b1"], { agentId: "x2", status: "async_launched" }),
      toolCalls(5, { id: "t5", name: "Bash" }),
      toolResults(6, ["t5"]),
      { type: "assistant", timestamp: at(9), message: { stop_reason: "end_turn", content: [] } },
    ];
    const subagent = jsonLines([
      { ...toolCalls(0, { id: "s1", name: "Read" }), timestamp: "2026-01-01T00:00:01.500Z" },
      toolResults(3, ["s1"]),
      { type: "assistant", timestamp: at(7), message: { content: [{ type: "text", text: "bg" }] } },
    ]);
    const plan = claudePlan(launched, new Map([["x2", subagent]]));
    expect(
      plan.events.map((event) => [event.payload.hook_event_name, event.payload.tool_use_id]),
    ).toEqual([
      ["SessionStart", undefined],
      ["UserPromptSubmit", undefined],
      ["PreToolUse", "b1"],
      ["PostToolUse", "b1"],
      ["PreToolUse", "s1"],
      ["PostToolUse", "s1"],
      ["PreToolUse", "t5"],
      ["PostToolUse", "t5"],
      ["SubagentStop", undefined],
      ["Stop", undefined],
      ["SessionEnd", undefined],
    ]);
  });

  it("replays a subagent started by another subagent inside its parent's Agent call", () => {
    const dig = { name: "Agent", input: { prompt: "dig deeper" } };
    const launched = [
      { ...said(0, "explore"), sessionId: "s1" },
      toolCalls(1, { id: "a1", name: "Agent" }),
      toolResults(9, ["a1"], { agentId: "x1" }),
      toolCalls(10, { id: "a2", name: "Agent" }),
      toolResults(12, ["a2"], { agentId: "x0" }),
      { type: "assistant", timestamp: at(13), message: { stop_reason: "end_turn", content: [] } },
    ];
    const parent = [
      said(1, "explore"),
      toolCalls(2, { id: "n1", ...dig }, { id: "n2", ...dig }),
      toolResults(8, ["n1", "n2"]),
    ];
    const child = [
      said(3, "dig deeper"),
      toolCalls(4, { id: "c1", name: "Read" }),
      toolResults(5, ["c1"]),
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plan = claudePlan(
      launched,
      new Map([
        ["x8", ["{"]],
        ["x9", jsonLines([said(0, "something else")])],
        ["x0", jsonLines([said(11, "dig deeper")])],
        ["x1", jsonLines(parent)],
        ["x2", jsonLines(child)],
        ["x3", jsonLines(child.slice(0, 1))],
      ]),
    );
    expect(plan.subagents.map(({ agentId, toolUseId }) => [agentId, toolUseId])).toEqual([
      ["x1", "a1"],
      ["x2", "n1"],
      ["x3", "n2"],
      ["x0", "a2"],
    ]);
    expect(
      plan.events.map((event) => [event.payload.hook_event_name, event.payload.tool_use_id]),
    ).toEqual([
      ["SessionStart", undefined],
      ["UserPromptSubmit", undefined],
      ["PreToolUse", "a1"],
      ["PreToolUse", "n1"],
      ["PreToolUse", "n2"],
      ["SubagentStop", undefined],
      ["PreToolUse", "c1"],
      ["PostToolUse", "c1"],
      ["SubagentStop", undefined],
      ["PostToolUse", "n1"],
      ["PostToolUse", "n2"],
      ["SubagentStop", undefined],
      ["PostToolUse", "a1"],
      ["PreToolUse", "a2"],
      ["SubagentStop", undefined],
      ["PostToolUse", "a2"],
      ["Stop", undefined],
      ["SessionEnd", undefined],
    ]);
    expect(plan.turns[0]?.minTools).toBe(5);
    expect(warn.mock.calls).toEqual([["skipping subagent x8, its transcript can't be read"]]);
    warn.mockRestore();
  });
});

describe("codexPlan", () => {
  it("emits the event that tool pacing waits on", () => {
    expect(codexPlan(codexRollout).events.map((event) => event.payload.hook_event_name)).toContain(
      TOOL_START_EVENT.codex,
    );
  });

  it("expects one turn per prompt with its tools and reply", () => {
    expect(codexPlan(codexRollout).turns).toEqual([
      {
        prompt: "list files",
        command: "",
        minTools: 1,
        maxTools: 1,
        reply: "One file.",
        expectsModelCall: true,
      },
    ]);
  });

  it("expects no model call for a turn the model never answered", () => {
    const imported = [
      codexRollout[0]!,
      codexRollout[1]!,
      codexRollout[2]!,
      { type: "response_item", payload: { type: "message", role: "user", content: [] } },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: null } },
    ];
    expect(codexPlan(imported).turns[0]?.expectsModelCall).toBe(false);
  });

  it("sends tool arguments as parsed JSON", () => {
    const tool = codexPlan(codexRollout).events.find(
      (event) => event.payload.hook_event_name === "PostToolUse",
    );
    expect(tool?.payload.tool_input).toEqual({ cmd: "ls" });
  });

  it("starts a fresh turn when a new task starts before the last one finished", () => {
    const abandoned = [
      ...codexRollout.slice(0, 3),
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
      { type: "event_msg", payload: { type: "user_message", message: "try again" } },
    ];
    expect(codexPlan(abandoned).turns.map((turn) => turn.prompt)).toEqual([
      "list files",
      "try again",
    ]);
  });

  it("reads prompts from the conversation when the session logged no prompt events", () => {
    const finish = { type: "event_msg", payload: { type: "task_complete" } };
    const newerSession = [
      codexRollout[0]!,
      codexRollout[1]!,
      codexUserMessage(
        "<environment_context>cwd</environment_context>",
        "<goal_context>ship it</goal_context>",
      ),
      codexUserMessage('<image name=[Image #1] path="dot.png">', "</image>", "What color?"),
      finish,
      codexUserMessage("<user_shell_command>\n<command>\nls\n</command>\n<result>a.txt</result>"),
      finish,
    ];
    expect(codexPlan(newerSession).turns.map((turn) => turn.prompt)).toEqual(["What color?", "ls"]);
  });

  it("leaves subagent threads to their parent", () => {
    const child = [
      { type: "session_meta", payload: { id: "c2", source: { subagent: {} } } },
      ...codexRollout.slice(1),
    ];
    expect(codexPlan(child).turns).toEqual([]);
  });
});
