// Ollama Cloud credential validation: an API key is valid iff it is a
// non-empty string (keys never expire; network validation happens during
// login via validateApiKey).

import type { AccountConfig } from "../../types.js";
import type { CredentialValidationResult } from "../adapter.js";
import { getCredential } from "../registry.js";

/**
 * Ollama API key for an account: the `ollama` credential in the
 * parent-account model, falling back to the legacy flat `apiKey` field.
 */
export function getOllamaApiKey(config: AccountConfig): string | undefined {
  return getCredential(config, "ollama")?.apiKey;
}

export async function validateCredentials(
  config: AccountConfig,
): Promise<CredentialValidationResult> {
  if (typeof getOllamaApiKey(config) !== "string" || getOllamaApiKey(config)!.trim() === "") {
    return {
      ok: false,
      status: 0,
      error: "Ollama account is missing an apiKey",
    };
  }
  return { ok: true };
}