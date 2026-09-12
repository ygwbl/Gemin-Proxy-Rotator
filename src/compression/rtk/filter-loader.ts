import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RtkFilterDefinition } from "./filter-types.js";

let loadedFilters: RtkFilterDefinition[] | null = null;
const regexCache = new Map<string, RegExp>();

function getRegex(pattern: string, flags = "im"): RegExp | null {
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

export function loadBuiltinRtkFilters(): RtkFilterDefinition[] {
  if (loadedFilters) return loadedFilters;
  const filtersDir = join(import.meta.dirname, "filters");
  const result: RtkFilterDefinition[] = [];

  try {
    const files = readdirSync(filtersDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = readFileSync(join(filtersDir, file), "utf-8");
        const parsed = JSON.parse(content) as RtkFilterDefinition;
        if (parsed.id && parsed.label) {
          result.push(parsed);
        }
      } catch {
        // Skip malformed filter JSONs
      }
    }
  } catch {
    // If directory doesn't exist
  }

  loadedFilters = result;
  return loadedFilters;
}

export function matchRtkFilter(
  commandType: string | null,
  command: string | null,
  text: string,
): RtkFilterDefinition | null {
  const filters = loadBuiltinRtkFilters();

  if (commandType) {
    const matchByType = filters.find((f) => f.id === commandType);
    if (matchByType) return matchByType;
  }

  if (command) {
    const matchByCmd = filters.find((f) => {
      if (!f.match?.commands) return false;
      return f.match.commands.some((cmd) => {
        const re = getRegex(`^${cmd}\\b`, "i");
        return re ? re.test(command) : false;
      });
    });
    if (matchByCmd) return matchByCmd;
  }

  // Fallback to pattern matching
  for (const filter of filters) {
    if (!filter.match?.patterns || filter.match.patterns.length === 0) continue;
    const allMatch = filter.match.patterns.every((pat) => {
      const re = getRegex(pat, "im");
      return re ? re.test(text) : false;
    });
    if (allMatch) return filter;
  }

  // Generic fallback if no specific filter matches
  return filters.find((f) => f.id === "generic-output") || null;
}
