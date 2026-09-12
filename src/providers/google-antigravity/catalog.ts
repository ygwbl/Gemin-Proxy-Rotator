// Google Antigravity provider catalog: per-model context windows.
//
// Sources (verified at fetch time):
//   - Google DeepMind model pages (https://deepmind.google/models/gemini/*)
//   - Google AI Studio / Gemini API docs (https://ai.google.dev/gemini-api/docs/models)
//   - Anthropic Claude models overview (https://docs.anthropic.com/en/docs/about-claude/models/overview)
//   - OpenAI model docs (https://platform.openai.com/docs/models, https://platform.openai.com/docs/models/gpt-oss-120b)
//
// Values reflect input/context window only. Output max tokens are tracked
// separately in `src/compat/model-specs.ts` via `maxOutputTokens`.

import { dynamicCatalog } from "./dynamic-catalog.js";
import { getModelSpecOverride } from "../../compat/model-specs.js";

export interface AntigravityModelSpec {
  id: string;
  contextWindow: number;
}

/**
 * Exact context windows per Antigravity (Cloud Code Assist) model id, as
 * published by the upstream providers.
 *
 * The keys are normalized to the lower-cased id used by the request path so
 * `getAntigravityContextWindow` can do an O(1) lookup.
 */
export const ANTIGRAVITY_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic Claude 4.6 family — 1M context window per Anthropic docs.
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-6-thinking": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-6-thinking": 1_000_000,
  // Anthropic Claude 4.5 family — 200K context window per Anthropic docs.
  "claude-opus-4-5": 200_000,
  "claude-opus-4-5-thinking": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-5-thinking": 200_000,
  // OpenAI gpt-oss-120b — 131,072 per platform.openai.com/docs/models/gpt-oss-120b.
  "gpt-oss-120b": 131_072,
  "gpt-oss-120b-medium": 131_072,
  // Google Gemini 3.x — 1M context window per deepmind.google/models/gemini/*.
  "gemini-3.8-flash-high": 1_000_000,
  "gemini-3.8-flash-medium": 1_000_000,
  "gemini-3.8-flash-low": 1_000_000,
  "gemini-3.7-flash": 1_000_000,
  "gemini-3.7-flash-tiered": 1_000_000,
  "gemini-3.6-flash": 1_000_000,
  "gemini-3.6-flash-high": 1_000_000,
  "gemini-3.6-flash-medium": 1_000_000,
  "gemini-3.6-flash-low": 1_000_000,
  "gemini-3.6-flash-tiered": 1_000_000,
  "gemini-3-flash": 1_000_000,
  "gemini-3-flash-agent": 1_000_000,
  "gemini-3-pro": 1_000_000,
  "gemini-3-pro-high": 1_000_000,
  "gemini-3-pro-low": 1_000_000,
  "gemini-3.1-pro": 1_000_000,
  "gemini-3.1-pro-high": 1_000_000,
  "gemini-3.1-pro-low": 1_000_000,
  "gemini-3.1-pro-preview": 1_000_000,
  // Google Gemini 2.5 — 1M context window per Google docs.
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  // Antigravity-internal alias mapped to the Gemini Pro family.
  "gemini-pro-agent": 1_000_000,
};

const CLAUDE_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const GEMINI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const GPT_OSS_DEFAULT_CONTEXT_WINDOW = 131_072;
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Resolve the upstream-published context window for an Antigravity model id.
 *
 * Lookup order:
 *   1. Operator exact/substring override.
 *   2. Exact id match in static table (lowercased).
 *   3. Dynamic catalog entry from live Antigravity endpoint.
 *   4. Substring match across the table (longest key wins via the order here).
 *   5. Family defaults: claude -> 1M, gemini -> 1M, gpt-oss -> 131_072.
 *   6. Defensive fallback: 128_000.
 */
export function getAntigravityContextWindow(model: string): number {
  if (!model) return FALLBACK_CONTEXT_WINDOW;
  const lower = model.toLowerCase().trim();
  if (!lower) return FALLBACK_CONTEXT_WINDOW;
  const overrideCtx = getModelSpecOverride(lower)?.contextWindow;
  if (typeof overrideCtx === "number" && Number.isFinite(overrideCtx) && overrideCtx > 0) {
    return overrideCtx;
  }
  const exact = ANTIGRAVITY_CONTEXT_WINDOWS[lower];
  if (typeof exact === "number") return exact;
  const dynamicCtx = dynamicCatalog.getContextWindow(lower);
  if (typeof dynamicCtx === "number") return dynamicCtx;
  // Substring fallback: pick the longest registered key that appears in lower.
  let best: { key: string; value: number } | null = null;
  for (const [key, value] of Object.entries(ANTIGRAVITY_CONTEXT_WINDOWS)) {
    if (lower.includes(key)) {
      if (!best || key.length > best.key.length) best = { key, value };
    }
  }
  if (best) return best.value;
  if (lower.includes("claude")) return CLAUDE_DEFAULT_CONTEXT_WINDOW;
  if (lower.includes("gemini")) return GEMINI_DEFAULT_CONTEXT_WINDOW;
  if (lower.includes("gpt-oss")) return GPT_OSS_DEFAULT_CONTEXT_WINDOW;
  return FALLBACK_CONTEXT_WINDOW;
}
