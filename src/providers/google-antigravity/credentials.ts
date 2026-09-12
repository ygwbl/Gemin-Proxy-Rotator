// Google Antigravity credential validation.
//
// Google accounts are validated through the OAuth flow itself (the exchange
// fails for invalid credentials), so there is nothing else to probe here.

import type { AccountConfig } from "../../types.js";
import type { CredentialValidationResult } from "../adapter.js";

export async function validateCredentials(
  config: AccountConfig,
): Promise<CredentialValidationResult> {
  if (
    config.provider !== "google-antigravity" ||
    typeof config.refreshToken !== "string" ||
    config.refreshToken.length === 0
  ) {
    return {
      ok: false,
      status: 0,
      error: "Missing refreshToken for Google Antigravity account",
    };
  }
  return { ok: true };
}