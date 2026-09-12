// API key validation for the Ollama Cloud (ollama.com) login flows.
// Both the CLI (login.ts) and the dashboard (onboarding.ts) use this.

import { fetchWithRetry } from "../../fetch-with-retry.js";
import { OLLAMA_USAGE_URL, OLLAMA_USER_AGENT } from "../../types.js";

export type ApiKeyValidationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Validate an Ollama Cloud API key by hitting `GET /api/usage` with it.
 * 200 → valid key. 401/403 → invalid/revoked key. Anything else → treated
 * as inconclusive (still an error, but the key may be fine).
 */
export async function validateApiKey(
  apiKey: string,
): Promise<ApiKeyValidationResult> {
  try {
    const response = await fetchWithRetry(OLLAMA_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "User-Agent": OLLAMA_USER_AGENT,
      },
      timeoutMs: 10_000,
    });

    if (response.ok) return { ok: true };

    const body = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        error:
          body.trim().slice(0, 300) ||
          "Invalid API key (unauthorized). Create one at ollama.com/settings/keys.",
      };
    }
    return {
      ok: false,
      status: response.status,
      error: `Usage endpoint returned HTTP ${response.status}: ${body.trim().slice(0, 300)}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `Network error while validating API key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Build a stable account identifier for a key that has no email attached. */
export function defaultAccountEmail(apiKey: string): string {
  const suffix = apiKey.trim().slice(-6).toLowerCase();
  return `key-${suffix}@ollama.local`;
}
