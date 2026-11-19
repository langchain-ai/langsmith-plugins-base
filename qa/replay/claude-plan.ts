import {
  CLAUDE_BLOCKED_STOP,
  CLAUDE_STOP_CONTEXT,
  CLAUDE_COMMAND_PROMPT,
  CLAUDE_LOCAL_COMMAND_SUBTYPE,
  CLAUDE_LOCAL_OUTPUT_PREFIX,
  CLAUDE_NON_PROMPT_PREFIX,
  CLAUDE_PEER_ORIGIN,
  CLAUDE_SHELL_PROMPT,
  CLAUDE_SYSTEM_REMINDER,
  CLAUDE_TASK_NOTIFICATION,
  CLAUDE_TASK_SUMMARY,
  DEFAULT_SUBAGENT_TYPE,
  PRE_TOOL_EVENT,
  REPLAY_PERMISSION_MODE,
  SESSION_END,
  SESSION_START,
  SKILL_TOOL_NAME,
  SUBAGENT_BACKGROUND_STATUS,
  SUBAGENT_STOP_EVENT,
} from "../constants.ts";
import type {
  PlacedSubagent,
  ReplayEvent,
  ReplayPlan,
  ScenarioTurn,
  SubagentLaunch,
  SubagentTranscripts,
  TimedReplayEvent,
  TranscriptLine,
} from "../models.ts";
import { textOf } from "../utils/text.ts";

function blocks(line: TranscriptLine, type: string): TranscriptLine[] {
  const content = line.message?.content;
  return Array.isArray(content) ? content.filter((block) => block?.type === type) : [];
}

function isUserText(line: TranscriptLine | undefined): line is TranscriptLine & { type: "user" } {
  if (
    line?.type !== "user" ||
    line.isCompactSummary ||
    line.isSidechain ||
    line.queueTranscriptOnly
  )
    return false;
  if (line.isMeta && line.origin?.kind !== CLAUDE_PEER_ORIGIN && line.turnPosition === undefined)
    return false;
  return blocks(line, "tool_result").length === 0;
}

function isPrompt(lines: TranscriptLine[], index: number): boolean {
  const line = lines[index];
  if (!isUserText(line) || CLAUDE_NON_PROMPT_PREFIX.test(textOf(line.message?.content)))
    return false;
  const reply = lines
    .slice(index + 1)
    .find((later) => isUserText(later) || later.subtype === CLAUDE_LOCAL_COMMAND_SUBTYPE);
  return (
    reply?.subtype !== CLAUDE_LOCAL_COMMAND_SUBTYPE &&
    !CLAUDE_LOCAL_OUTPUT_PREFIX.test(textOf(reply?.message?.content))
  );
}

function promptText(line: TranscriptLine): string {
  const text = textOf(line.message?.content).replace(CLAUDE_SYSTEM_REMINDER, "").trim();
  const command = CLAUDE_COMMAND_PROMPT.exec(text);
  if (command !== null) return `${command[1]?.trim()} ${command[2]?.trim() ?? ""}`.trim();
  return (
    CLAUDE_SHELL_PROMPT.exec(text)?.[1]?.trim() ??
    CLAUDE_TASK_SUMMARY.exec(text)?.[1]?.trim() ??
    text
  );
}

function endsTurn(lines: TranscriptLine[], index: number): boolean {
  const line = lines[index];
  if (line?.type !== "assistant" || line.isSidechain || line.message?.stop_reason !== "end_turn")
    return false;
  const later = lines.slice(index + 1);
  const next = later.find((after) => after.type === "assistant" || isUserText(after));
  const companion = later.find((after) => after === next || after.turnCompanion)?.turnCompanion;
  if (companion) return isUserText(next);
  return next === undefined || next.message?.id !== line.message?.id;
}

function preToolUse(use: TranscriptLine): Record<string, unknown> {
  return {
    hook_event_name: PRE_TOOL_EVENT,
    tool_name: use.name,
    tool_input: use.input,
    tool_use_id: use.id,
  };
}

function postToolUse(
  line: TranscriptLine,
  result: TranscriptLine,
  use: TranscriptLine | undefined,
): Record<string, unknown> {
  return {
    hook_event_name: result.is_error ? "PostToolUseFailure" : "PostToolUse",
    tool_name: use?.name ?? "unknown",
    tool_input: use?.input ?? {},
    tool_use_id: result.tool_use_id,
    tool_response: line.toolUseResult ?? result.content,
  };
}

function timeOf(line: TranscriptLine | undefined): number {
  return Date.parse(String(line?.timestamp));
}

function firstPrompt(lines: string[] | undefined): string {
  const first = lines?.[0] === undefined ? undefined : (JSON.parse(lines[0]) as TranscriptLine);
  return textOf(first?.message?.content);
}

function readable(agentId: string, lines: string[]): boolean {
  try {
    firstPrompt(lines);
    return true;
  } catch {
    console.warn(`skipping subagent ${agentId}, its transcript can't be read`);
    return false;
  }
}

function launchedSubagent(
  transcripts: SubagentTranscripts,
  launched: SubagentLaunch[],
  line: TranscriptLine,
  result: TranscriptLine,
  use: TranscriptLine | undefined,
): SubagentLaunch | undefined {
  const prompt = use?.input?.prompt;
  const unused = (id: string) => !launched.some((launch) => launch.agentId === id);
  const agentId =
    line.toolUseResult?.agentId === undefined
      ? [...transcripts.keys()].find(
          (id) =>
            typeof prompt === "string" && unused(id) && firstPrompt(transcripts.get(id)) === prompt,
        )
      : String(line.toolUseResult.agentId);
  const lines = agentId === undefined ? undefined : transcripts.get(agentId);
  if (agentId === undefined || lines === undefined) return undefined;
  const launch = {
    agentId,
    toolUseId: String(result.tool_use_id),
    agentType: String(use?.input?.subagent_type ?? DEFAULT_SUBAGENT_TYPE),
    lines,
  };
  launched.push(launch);
  return launch;
}

function subagentEvents(
  sessionId: string,
  launch: SubagentLaunch,
  transcripts: SubagentTranscripts,
  launched: SubagentLaunch[],
): TimedReplayEvent[] {
  const lines = launch.lines.map((line) => JSON.parse(line) as TranscriptLine);
  const toolUses = new Map<string, TranscriptLine>();
  const events: TimedReplayEvent[] = [];
  let lastText = "";
  let at = Number.NaN;
  const emit = (transcriptLines: number, fields: Record<string, unknown>) => {
    events.push({
      at,
      event: {
        agentId: launch.agentId,
        transcriptLines,
        payload: {
          session_id: sessionId,
          permission_mode: REPLAY_PERMISSION_MODE,
          agent_id: launch.agentId,
          agent_type: launch.agentType,
          ...fields,
        },
      },
    });
  };
  for (const [index, line] of lines.entries()) {
    at = timeOf(line);
    if (line.type === "assistant") {
      for (const text of blocks(line, "text")) lastText = String(text.text);
      for (const use of blocks(line, "tool_use")) {
        if (use.id === launch.toolUseId) continue;
        toolUses.set(use.id, use);
        emit(index + 1, preToolUse(use));
      }
    }
    for (const result of line.type === "user" ? blocks(line, "tool_result") : []) {
      if (result.tool_use_id === launch.toolUseId) continue;
      const use = toolUses.get(result.tool_use_id);
      const child = launchedSubagent(transcripts, launched, line, result, use);
      if (child !== undefined)
        events.push(...subagentEvents(sessionId, child, transcripts, launched));
      emit(index + 1, postToolUse(line, result, use));
    }
  }
  emit(lines.length, {
    hook_event_name: SUBAGENT_STOP_EVENT,
    stop_hook_active: false,
    last_assistant_message: lastText,
  });
  return events;
}

function slotFor(at: number, times: number[], subagent: PlacedSubagent): number {
  const first = subagent.background ? subagent.postToolUseIndex + 1 : 0;
  const last = subagent.background ? times.length : subagent.postToolUseIndex;
  const later = times.findIndex((time, index) => index >= first && time > at);
  return Math.min(Math.max(later === -1 ? times.length : later, first), last);
}

function withSubagents(
  events: ReplayEvent[],
  times: number[],
  subagents: PlacedSubagent[],
): ReplayEvent[] {
  const slotted = subagents
    .flatMap((subagent) =>
      subagent.events.map((timed) => ({ ...timed, slot: slotFor(timed.at, times, subagent) })),
    )
    .toSorted((left, right) => left.slot - right.slot || left.at - right.at);
  return events.flatMap((event, index) => [
    ...slotted.filter(({ slot }) => slot === index).map((timed) => timed.event),
    event,
    ...(index === events.length - 1
      ? slotted.filter(({ slot }) => slot === events.length).map((timed) => timed.event)
      : []),
  ]);
}

export function claudePlan(
  lines: TranscriptLine[],
  subagentTranscripts: SubagentTranscripts = new Map(),
): ReplayPlan {
  const sessionId = String(lines.find((line) => line.sessionId)?.sessionId ?? "");
  const toolUses = new Map<string, TranscriptLine>();
  const events: ReplayEvent[] = [];
  const times: number[] = [];
  const turns: ScenarioTurn[] = [];
  const subagents: SubagentLaunch[] = [];
  const placed: PlacedSubagent[] = [];
  const claimed = new Set(lines.flatMap((line) => line.toolUseResult?.agentId ?? []).map(String));
  const unclaimed = new Map(
    [...subagentTranscripts].filter(
      ([id, transcript]) => !claimed.has(id) && readable(id, transcript),
    ),
  );
  let current: ScenarioTurn | undefined;
  let stopHookActive = false;
  let lastText = "";
  let at = Number.NaN;

  const emit = (transcriptLines: number, fields: Record<string, unknown>) => {
    times.push(at);
    events.push({
      transcriptLines,
      payload: {
        session_id: sessionId,
        permission_mode: REPLAY_PERMISSION_MODE,
        ...fields,
      },
    });
  };

  for (const [index, line] of lines.entries()) {
    at = timeOf(line);
    if (line.type === "system" && line.subtype === "compact_boundary") {
      emit(index, {
        hook_event_name: "PreCompact",
        trigger: line.compactMetadata?.trigger ?? "auto",
      });
    }
    if (line.type === "user" && line.isCompactSummary) {
      emit(index + 1, {
        hook_event_name: "PostCompact",
        trigger: "auto",
        compact_summary: textOf(line.message?.content),
      });
    }
    const { type, hookEvent } = line.attachment ?? {};
    const stopContinues = type === CLAUDE_BLOCKED_STOP || type === CLAUDE_STOP_CONTEXT;
    if (current === undefined && stopContinues && hookEvent === "Stop") {
      current = turns.at(-1);
      stopHookActive = true;
    }
    const joins = line.isMeta || CLAUDE_TASK_NOTIFICATION.test(textOf(line.message?.content));
    if (isPrompt(lines, index) && !(joins && current !== undefined)) {
      current = {
        prompt: promptText(line),
        command: "",
        minTools: 0,
        maxTools: 0,
        reply: null,
        expectsModelCall: false,
      };
      turns.push(current);
      lastText = "";
      emit(index, { hook_event_name: "UserPromptSubmit", prompt: current.prompt });
    }
    if (line.type === "assistant" && !line.isSidechain && current === undefined) {
      current = {
        prompt: "",
        command: "",
        minTools: 0,
        maxTools: 0,
        reply: null,
        expectsModelCall: false,
      };
      turns.push(current);
      lastText = "";
    }
    if (line.type === "assistant" && !line.isSidechain) {
      if (current !== undefined) current.expectsModelCall = true;
      for (const text of blocks(line, "text")) lastText = String(text.text);
      for (const use of blocks(line, "tool_use")) {
        toolUses.set(use.id, use);
        emit(index + 1, preToolUse(use));
      }
    }
    for (const result of line.type === "user" ? blocks(line, "tool_result") : []) {
      const use = toolUses.get(result.tool_use_id);
      if (current !== undefined && use !== undefined && use.name !== SKILL_TOOL_NAME) {
        current.minTools += 1;
        current.maxTools = current.minTools;
      }
      const launch = launchedSubagent(subagentTranscripts, subagents, line, result, use);
      if (launch !== undefined) {
        const timed = subagentEvents(sessionId, launch, unclaimed, subagents);
        const subagentTools = timed.filter(
          ({ event }) =>
            event.payload.hook_event_name !== PRE_TOOL_EVENT &&
            event.payload.hook_event_name !== SUBAGENT_STOP_EVENT &&
            event.payload.tool_name !== SKILL_TOOL_NAME,
        ).length;
        if (current !== undefined) {
          current.minTools += subagentTools;
          current.maxTools = current.minTools;
        }
        placed.push({
          events: timed,
          postToolUseIndex: events.length,
          background: line.toolUseResult?.status === SUBAGENT_BACKGROUND_STATUS,
        });
      }
      emit(index + 1, postToolUse(line, result, use));
    }
    if (endsTurn(lines, index) && current !== undefined) {
      if (lastText.length > 0) current.reply = lastText;
      emit(index + 1, {
        hook_event_name: "Stop",
        stop_hook_active: stopHookActive,
        last_assistant_message: lastText,
      });
      current = undefined;
      stopHookActive = false;
    }
  }
  const replayed = withSubagents(events, times, placed);
  replayed.unshift({ transcriptLines: 0, payload: { ...events[0]?.payload, ...SESSION_START } });
  replayed.push({
    transcriptLines: lines.length,
    payload: { ...events.at(-1)?.payload, ...SESSION_END },
  });
  return { sessionId, events: replayed, turns, subagents };
}
