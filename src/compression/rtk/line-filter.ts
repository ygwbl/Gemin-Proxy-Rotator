import type { RtkFilterDefinition } from "./filter-types.js";
import { smartTruncate } from "./smart-truncate.js";
import { deduplicateRepeatedLines } from "./deduplicator.js";

export interface LineFilterResult {
  text: string;
  strippedLines: number;
  keptByRule: boolean;
  appliedRules: string[];
}

const regexCache = new Map<string, RegExp>();

function getRegex(pattern: string, flags = "i"): RegExp | null {
  const key = `${pattern}::${flags}`;
  let re = regexCache.get(key);
  if (!re) {
    try {
      re = new RegExp(pattern, flags);
      regexCache.set(key, re);
    } catch {
      return null;
    }
  }
  return re;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function applyLineFilter(
  text: string,
  filter: RtkFilterDefinition,
): LineFilterResult {
  const appliedRules: string[] = [];
  let currentText = text;

  if (filter.rules?.stripAnsi !== false) {
    currentText = stripAnsi(currentText);
    appliedRules.push("strip-ansi");
  }

  const lines = currentText.split(/\r?\n/);
  const totalOriginalLines = lines.length;
  const filteredLines: string[] = [];

  const dropRegexes = (filter.rules?.dropPatterns || [])
    .map((p) => getRegex(p))
    .filter((r): r is RegExp => r !== null);

  const includeRegexes = (filter.rules?.includePatterns || [])
    .map((p) => getRegex(p))
    .filter((r): r is RegExp => r !== null);

  const errorRegexes = (filter.preserve?.errorPatterns || [])
    .map((p) => getRegex(p))
    .filter((r): r is RegExp => r !== null);

  const summaryRegexes = (filter.preserve?.summaryPatterns || [])
    .map((p) => getRegex(p))
    .filter((r): r is RegExp => r !== null);

  for (const line of lines) {
    const isError = errorRegexes.some((r) => r.test(line));
    const isSummary = summaryRegexes.some((r) => r.test(line));

    if (isError || isSummary) {
      filteredLines.push(line);
      continue;
    }

    if (dropRegexes.length > 0) {
      const shouldDrop = dropRegexes.some((r) => r.test(line));
      if (shouldDrop) {
        continue;
      }
    }

    if (includeRegexes.length > 0) {
      const shouldInclude = includeRegexes.some((r) => r.test(line));
      if (!shouldInclude) {
        continue;
      }
    }

    filteredLines.push(line);
  }

  let resultText = filteredLines.join("\n");

  if (filter.rules?.collapseDuplicates !== false) {
    const dedup = deduplicateRepeatedLines(resultText);
    resultText = dedup.text;
    if (dedup.collapsed > 0) {
      appliedRules.push(`dedup:${dedup.collapsed}`);
    }
  }

  const maxLines = filter.rules?.maxLines || filter.rtkTomlMaxLines || 100;
  if (resultText.split("\n").length > maxLines) {
    const truncated = smartTruncate(resultText, {
      maxLines,
      preserveHead: filter.rtkTomlHeadLines || 15,
      preserveTail: filter.rtkTomlTailLines || 15,
      priorityPatterns: [...errorRegexes, ...summaryRegexes],
    });
    resultText = truncated.text;
    appliedRules.push("smart-truncate");
  }

  const strippedLines = Math.max(
    0,
    totalOriginalLines - resultText.split("\n").length,
  );

  return {
    text: resultText,
    strippedLines,
    keptByRule: filteredLines.length > 0,
    appliedRules,
  };
}
