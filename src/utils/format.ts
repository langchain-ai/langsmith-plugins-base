import { TEMPLATE_PLACEHOLDER } from "./constants.js";

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(TEMPLATE_PLACEHOLDER, (_match, key: string) => String(values[key]));
}

export function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}
