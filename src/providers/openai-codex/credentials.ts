import type { AccountConfig, AccountRuntime, ProviderCredential } from "../../types.js";
import { loadConfig, saveAccountsConfig } from "../../config-storage.js";
import { getCredential } from "../credential-helpers.js";
import { CODEX_PROVIDER_ID } from "./oauth.js";

export interface ProviderTokenState {
  accessToken: string | null;
  tokenExpires: number;
}

export function getCodexCredential(account: AccountConfig): ProviderCredential | undefined {
  return getCredential(account, CODEX_PROVIDER_ID) as ProviderCredential | undefined;
}

export function getCodexRefreshToken(account: AccountConfig): string | undefined {
  const value = getCodexCredential(account)?.refreshToken;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function getCodexAccountId(account: AccountConfig): string | undefined {
  const value = getCodexCredential(account)?.providerAccountId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function getCodexTokenState(account: AccountRuntime): ProviderTokenState {
  return account.providerTokens?.[CODEX_PROVIDER_ID] ?? {
    accessToken: null,
    tokenExpires: 0,
  };
}

export function setCodexTokenState(account: AccountRuntime, state: ProviderTokenState): void {
  account.providerTokens ??= {};
  account.providerTokens[CODEX_PROVIDER_ID] = state;
}

/**
 * Persist a rotated refresh token in the same atomic settings transaction as
 * the rest of accounts.json. The per-account lock prevents two requests from
 * writing different generations of a one-time refresh token out of order.
 */
const persistenceLocks = new Map<string, Promise<void>>();

export async function persistCodexRefreshToken(
  account: AccountRuntime,
  refreshToken: string,
): Promise<void> {
  await persistCodexCredentialRefresh(loadConfig(), account, refreshToken);
}

/** Persist one credential while preserving every sibling account/provider. */
export async function persistCodexCredentialRefresh(
  config: Parameters<typeof saveAccountsConfig>[0],
  account: AccountRuntime,
  refreshToken: string,
): Promise<void> {
  const email = account.config.email.toLowerCase();
  const previous = persistenceLocks.get(email) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const accountConfig = config.accounts.find(
      (entry) => entry.email.toLowerCase() === email,
    );
    if (!accountConfig) throw new Error("Codex account disappeared while refreshing");
    const credentials = [...(accountConfig.credentials ?? account.config.credentials ?? [])];
    const index = credentials.findIndex((entry) => entry.provider === CODEX_PROVIDER_ID);
    if (index < 0) throw new Error("Codex credential is no longer present; re-authenticate");
    credentials[index] = { ...credentials[index], refreshToken };
    accountConfig.credentials = credentials;
    account.config.credentials = credentials;
    await saveAccountsConfig(config);
  });
  persistenceLocks.set(email, next);
  try {
    await next;
  } finally {
    if (persistenceLocks.get(email) === next) persistenceLocks.delete(email);
  }
}

export function isCodexCredential(config: AccountConfig): boolean {
  return Boolean(getCodexRefreshToken(config));
}
