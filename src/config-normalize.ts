// Normalization of account configs into the parent-account credential model.
// Kept in its own module so both config-defaults (load path) and
// account-store (write path) can use it without import cycles.

import type { AccountConfig } from "./types.js";
import { DEFAULT_PROVIDER, sortAccountCredentials } from "./providers/credential-helpers.js";

/**
 * Migrate a flat legacy account shape (provider/apiKey/refreshToken at the
 * top level) into the parent-account model where `email` owns a list of
 * per-provider credentials. Existing credential arrays are also repaired when
 * they coexist with legacy fields: adding a provider must not strand a
 * pre-existing Google or Ollama credential in the deprecated top-level shape.
 * Runs on every config load (applyConfigDefaults), so both the persisted DB
 * config and legacy files normalize transparently.
 */
export function normalizeAccountConfig(account: AccountConfig): AccountConfig {
  const provider = account.provider ?? DEFAULT_PROVIDER;
  const credentials = Array.isArray(account.credentials)
    ? [...account.credentials]
    : [];
  const providers = new Set(credentials.map((credential) => credential.provider));

  const addCredential = (credential: NonNullable<AccountConfig["credentials"]>[number]): void => {
    if (providers.has(credential.provider)) return;
    credentials.push(credential);
    providers.add(credential.provider);
  };

  if (
    typeof account.apiKey === "string" &&
    account.apiKey.trim() !== ""
  ) {
    if (!providers.has(provider)) {
      addCredential({
        provider,
        apiKey: account.apiKey,
        proxyUrl: account.proxyUrl,
      });
    }
  }

  if (
    !providers.has("openai-codex") &&
    (provider === "openai-codex" ||
      typeof account.codexRefreshToken === "string" ||
      typeof account.codexAccountId === "string")
  ) {
    addCredential({
      provider: "openai-codex",
      refreshToken: account.codexRefreshToken ?? account.refreshToken,
      providerAccountId: account.codexAccountId,
      proxyUrl: account.proxyUrl,
    });
  }

  // A projectId/projectSource is unambiguously an Antigravity legacy field.
  // When the legacy provider was not Codex, refreshToken is sufficient too.
  // Codex also used a top-level refreshToken historically, so do not reinterpret
  // that field as Google unless there is a Google-specific marker.
  const hasLegacyGoogleFields =
    account.projectId !== undefined ||
    account.projectSource !== undefined ||
    (provider !== "openai-codex" && account.refreshToken !== undefined);
  if (!providers.has(DEFAULT_PROVIDER) && hasLegacyGoogleFields) {
    addCredential({
      provider: DEFAULT_PROVIDER,
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      projectSource: account.projectSource,
      proxyUrl: account.proxyUrl,
    });
  }

  if (credentials.length > 0) {
    const sorted = sortAccountCredentials(credentials);
    if (
      Array.isArray(account.credentials) &&
      credentials.length === account.credentials.length &&
      JSON.stringify(sorted) === JSON.stringify(account.credentials)
    ) {
      return account;
    }
    return { ...account, credentials: sorted };
  }

  // Mirror the flat legacy fields onto the parent-account credentials and
  // KEEP the top-level fields: Google reads (forward/quota/index) still
  // consult them, so both shapes coexist until the runtime migrates.
  return account;
}
