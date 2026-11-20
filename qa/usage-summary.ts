import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { UsageSample } from "./models.ts";
import { usageChange, usageSummary, usagesFromLog } from "./replay/usage.ts";

function readUsages(files: string[]): UsageSample[] {
  const usages = files.flatMap((file) => usagesFromLog(readFileSync(file, "utf8")));
  if (usages.length === 0) throw new Error(`no usage lines found in ${files.join(", ")}`);
  return usages;
}

const { values, positionals } = parseArgs({
  options: { baseline: { type: "string" } },
  allowPositionals: true,
});
const usages = readUsages(positionals);
console.log(usageSummary(usages));
if (values.baseline) console.log(`\n${usageChange(usages, readUsages([values.baseline]))}`);
