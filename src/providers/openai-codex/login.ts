import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AccountConfig } from "../../types.js";
import {
  buildCodexAuthorizationUrl,
  codexOAuthErrorMessage,
  createCodexAuthorizationFlow,
  exchangeCodexAuthorizationCode,
  getCodexOAuthConfig,
  parseCodexIdentity,
  startCodexCallbackServer,
  type CodexTokens,
} from "./oauth.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function tokenContainer(input: Record<string, unknown>): Record<string, unknown> {
  const provider = isRecord(input["openai-codex"]) ? input["openai-codex"] : undefined;
  const providers = isRecord(input.providers) && isRecord(input.providers["openai-codex"])
    ? input.providers["openai-codex"]
    : undefined;
  const tokens = isRecord(input.tokens) ? input.tokens : undefined;
  const providerTokens = provider && isRecord(provider.tokens) ? provider.tokens : undefined;
  const nestedProviderTokens = providers && isRecord(providers.tokens) ? providers.tokens : undefined;
  return {
    ...input,
    ...(provider ?? {}),
    ...(providers ?? {}),
    ...(tokens ?? {}),
    ...(providerTokens ?? {}),
    ...(nestedProviderTokens ?? {}),
  };
}

export interface ParsedCodexAuth {
  account: AccountConfig;
  accessToken?: string;
  idToken?: string;
}

/** Parse Codex CLI, pi-ai, Hermes and flat JSON exports without accepting raw CLI tokens. */
export function parseCodexAuthImport(input: unknown): ParsedCodexAuth {
  if (!isRecord(input)) throw new Error("Invalid Codex auth import: expected a JSON object");
  const data = tokenContainer(input);
  const accessToken = firstString(data.access_token, data.accessToken, data.access, input.access_token);
  const refreshToken = firstString(data.refresh_token, data.refreshToken, data.refresh, input.refresh_token);
  if (!refreshToken) throw new Error("Invalid Codex auth import: refresh_token is required");
  const idToken = firstString(data.id_token, data.idToken);
  const identity = parseCodexIdentity(accessToken, idToken);
  const email = firstString(
    data.email,
    data.account_email,
    data.accountEmail,
    input.email,
    identity.email,
  );
  const providerAccountId = firstString(
    data.providerAccountId,
    data.account_id,
    data.accountId,
    data.chatgpt_account_id,
    identity.providerAccountId,
  );
  if (!email && !providerAccountId) {
    throw new Error("Invalid Codex auth import: email or ChatGPT account id is required");
  }
  const stableEmail = email ?? `${providerAccountId}@codex.local`;
  return {
    account: {
      email: stableEmail,
      label: stableEmail.split("@")[0],
      credentials: [{
        provider: "openai-codex",
        refreshToken,
        ...(providerAccountId ? { providerAccountId } : {}),
      }],
    },
    ...(accessToken ? { accessToken } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

export async function importCodexAuthFile(path: string): Promise<ParsedCodexAuth> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Could not read Codex auth import file: ${path}`);
  }
  return parseCodexAuthImport(parsed);
}

function parseCallbackInput(value: string): { code?: string; state?: string } {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const url = new URL(trimmed);
    return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
  } catch {
    // Continue with a pasted query string or code.
  }
  const params = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
  if (params.has("code")) return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  return { code: trimmed };
}

export async function runCodexLogin(): Promise<AccountConfig> {
  const config = getCodexOAuthConfig();
  const flow = createCodexAuthorizationFlow(config);
  console.log("Open this URL to authenticate with OpenAI Codex:");
  console.log(flow.url);

  let code: string | undefined;
  let callback: Awaited<ReturnType<typeof startCodexCallbackServer>> | null = null;
  try {
    callback = await startCodexCallbackServer(flow.state, config);
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 180_000);
      timer.unref?.();
    });
    code = (await Promise.race([callback.waitForCode(), timeout])) ?? undefined;
  } catch {
    // Port conflicts are recoverable through the manual callback fallback.
  } finally {
    await callback?.close();
  }

  if (!code) {
    const readline = createInterface({ input, output });
    try {
      const pasted = await readline.question("Paste the complete OAuth callback URL (or code): ");
      const parsed = parseCallbackInput(pasted);
      if (parsed.state && parsed.state !== flow.state) throw new Error("OAuth state mismatch");
      code = parsed.code;
    } finally {
      readline.close();
    }
  }
  if (!code) throw new Error("Codex OAuth timed out or returned no authorization code");

  let tokens: CodexTokens;
  try {
    tokens = await exchangeCodexAuthorizationCode(code, flow.verifier, config);
  } catch (error) {
    throw new Error(codexOAuthErrorMessage(error), { cause: error });
  }
  const identity = parseCodexIdentity(tokens.accessToken, tokens.idToken);
  const email = identity.email ?? (identity.providerAccountId ? `${identity.providerAccountId}@codex.local` : undefined);
  if (!email) throw new Error("Codex OAuth did not return an account identity");
  return {
    email,
    label: email.split("@")[0],
    credentials: [{
      provider: "openai-codex",
      refreshToken: tokens.refreshToken,
      ...(identity.providerAccountId ? { providerAccountId: identity.providerAccountId } : {}),
    }],
  };
}

export function codexLoginUrlForTests(): string {
  const config = getCodexOAuthConfig();
  const flow = createCodexAuthorizationFlow(config);
  return buildCodexAuthorizationUrl(config, flow.state, "test");
}
