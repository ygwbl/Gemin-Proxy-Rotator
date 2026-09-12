// OpenCode Zen credential helpers and validation.

import type { AccountConfig } from "../../types.js";
import type { CredentialValidationResult } from "../adapter.js";
import { getCredential } from "../credential-helpers.js";

export const OPENCODE_ZEN_PROVIDER_ID = "opencode-zen";

export function getOpenCodeZenApiKey(config: AccountConfig): string | undefined {
  return getCredential(config, OPENCODE_ZEN_PROVIDER_ID)?.apiKey ?? config.apiKey;
}

export async function validateCredentials(
  config: AccountConfig,
): Promise<CredentialValidationResult> {
  const key = getOpenCodeZenApiKey(config);
  if (typeof key !== "string" || key.trim() === "") {
    return {
      ok: false,
      status: 0,
      error: "OpenCode Zen account is missing an apiKey",
    };
  }
  return { ok: true };
}

export function defaultAccountEmail(apiKey: string): string {
  const clean = apiKey.trim();
  const suffix = clean.length > 8 ? clean.slice(-8) : clean;
  return `zen-${suffix}@opencode.ai`;
}
