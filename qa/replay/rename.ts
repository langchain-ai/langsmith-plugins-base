import type { ScenarioTurn } from "../models.ts";

export function renamedTurns(
  turns: ScenarioTurn[],
  rename: (text: string) => string,
): ScenarioTurn[] {
  return turns.map((turn) => ({
    ...turn,
    prompt: rename(turn.prompt),
    ...(typeof turn.reply === "string" ? { reply: rename(turn.reply) } : {}),
  }));
}
