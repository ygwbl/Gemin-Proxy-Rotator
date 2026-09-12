import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export const CODEX_PROVIDER_ID = "openai-codex";
export const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const DEFAULT_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_CALLBACK_HOST = "127.0.0.1";
export const DEFAULT_CODEX_CALLBACK_PORT = 1455;
export const DEFAULT_CODEX_REDIRECT_HOST = "localhost";
export const DEFAULT_CODEX_SCOPE = "openid profile email offline_access";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

export interface CodexOAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  callbackHost: string;
  callbackPort: number;
  scope: string;
}

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
}

export interface CodexIdentity {
  email?: string;
  providerAccountId?: string;
  planType?: string;
}

export class CodexOAuthError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly reloginRequired: boolean;

  constructor(
    message: string,
    options: { code?: string; status?: number; reloginRequired?: boolean } = {},
  ) {
    super(message);
    this.name = "CodexOAuthError";
    this.code = options.code ?? "codex_oauth_error";
    this.status = options.status;
    this.reloginRequired = options.reloginRequired ?? false;
  }
}

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : DEFAULT_CODEX_CALLBACK_PORT;
}

export function getCodexOAuthConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): CodexOAuthConfig {
  const get = (name: string, fallback: string): string =>
    overrides[name]?.trim() || env(name, fallback);
  const callbackHost = get("CODEX_OAUTH_CALLBACK_HOST", DEFAULT_CODEX_CALLBACK_HOST);
  const callbackPort = parsePort(
    overrides.CODEX_OAUTH_CALLBACK_PORT ?? process.env.CODEX_OAUTH_CALLBACK_PORT,
  );
  const redirectUri = get(
    "CODEX_OAUTH_REDIRECT_URI",
    `http://${DEFAULT_CODEX_REDIRECT_HOST}:${callbackPort}/auth/callback`,
  );
  return {
    clientId: get("CODEX_OAUTH_CLIENT_ID", DEFAULT_CODEX_CLIENT_ID),
    authorizeUrl: get("CODEX_OAUTH_AUTHORIZE_URL", DEFAULT_CODEX_AUTHORIZE_URL),
    tokenUrl: get("CODEX_OAUTH_TOKEN_URL", DEFAULT_CODEX_TOKEN_URL),
    redirectUri,
    callbackHost,
    callbackPort,
    scope: get("CODEX_OAUTH_SCOPE", DEFAULT_CODEX_SCOPE),
  };
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createOAuthState(): string {
  return randomBytes(24).toString("hex");
}

export function buildCodexAuthorizationUrl(
  config: CodexOAuthConfig,
  state: string,
  challenge: string,
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // These flags are part of the Codex CLI flow and do not contain secrets.
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  // Force a fresh ChatGPT session so adding a second Codex account does not
  // silently reuse the first browser session.
  url.searchParams.set("prompt", "login");
  return url.toString();
}

function html(title: string, message: string): string {
  const escaped = message.replace(/[&<>"]|'/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${escaped}</p></body></html>`;
}

export interface CodexCallbackServer {
  server: Server;
  address: string;
  waitForCode(): Promise<string | null>;
  close(): Promise<void>;
  cancel(): void;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** Start a loopback-only callback server and reject callbacks with a bad state. */
export async function startCodexCallbackServer(
  state: string,
  options: Pick<CodexOAuthConfig, "callbackHost" | "callbackPort" | "redirectUri"> = getCodexOAuthConfig(),
): Promise<CodexCallbackServer> {
  if (!isLoopbackHost(options.callbackHost)) {
    throw new CodexOAuthError("Codex OAuth callback must bind to a loopback host.", {
      code: "invalid_callback_host",
    });
  }
  let resolveCode: (code: string | null) => void = () => undefined;
  let settled = false;
  const result = new Promise<string | null>((resolve) => {
    resolveCode = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
  });
  const callbackPath = new URL(options.redirectUri).pathname || "/auth/callback";
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${options.callbackHost}`);
      if (url.pathname !== callbackPath) {
        response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        response.end(html("Codex OAuth", "Callback route not found."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(html("Codex OAuth", "The OAuth state was invalid."));
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(html("Codex OAuth", "The authorization was cancelled or did not return a code."));
        resolveCode(null);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html("Codex OAuth", "Authentication completed. You can close this window."));
      resolveCode(code);
    } catch {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      response.end(html("Codex OAuth", "Could not process the callback."));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.callbackPort, options.callbackHost);
  });

  const addressInfo = server.address();
  const port = typeof addressInfo === "object" && addressInfo ? addressInfo.port : options.callbackPort;
  return {
    server,
    address: `http://${options.callbackHost}:${port}${callbackPath}`,
    waitForCode: () => result,
    cancel: () => resolveCode(null),
    close: async () => {
      resolveCode(null);
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseCodexIdentity(...tokens: Array<string | undefined>): CodexIdentity {
  const result: CodexIdentity = {};
  for (const token of tokens) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (!result.email && typeof payload.email === "string") result.email = payload.email;
    const auth = payload[CODEX_AUTH_CLAIM];
    if (auth && typeof auth === "object" && !Array.isArray(auth)) {
      const claims = auth as Record<string, unknown>;
      if (!result.providerAccountId && typeof claims.chatgpt_account_id === "string") {
        result.providerAccountId = claims.chatgpt_account_id;
      }
      if (!result.planType && typeof claims.chatgpt_plan_type === "string") {
        result.planType = claims.chatgpt_plan_type;
      }
      if (!result.email && typeof claims.email === "string") result.email = claims.email;
    }
    if (!result.providerAccountId && typeof payload.chatgpt_account_id === "string") {
      result.providerAccountId = payload.chatgpt_account_id;
    }
  }
  return result;
}

function parseTokenError(response: Response, body: unknown): CodexOAuthError {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const nested = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : null;
  const code = typeof nested?.code === "string"
    ? nested.code
    : typeof nested?.type === "string"
      ? nested.type
      : typeof record.error === "string"
        ? record.error
        : `http_${response.status}`;
  const relogin = response.status === 401 || response.status === 403 ||
    ["invalid_grant", "invalid_token", "refresh_token_reused"].includes(code);
  const message = code === "refresh_token_reused"
    ? "Codex refresh token was already used by another client; re-authentication is required."
    : `Codex OAuth request failed (${response.status}, ${code}).`;
  return new CodexOAuthError(message, { code, status: response.status, reloginRequired: relogin });
}

async function postToken(
  params: URLSearchParams,
  config: CodexOAuthConfig,
  previousRefreshToken?: string,
): Promise<CodexTokens> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params,
  });
  let body: unknown = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw parseTokenError(response, body);
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  const refreshToken = typeof record.refresh_token === "string" && record.refresh_token
    ? record.refresh_token
    : previousRefreshToken ?? "";
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 3600;
  if (!accessToken || !refreshToken) {
    throw new CodexOAuthError("Codex OAuth response did not include usable tokens.", {
      code: "token_response_incomplete",
      reloginRequired: true,
    });
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.max(1, expiresIn) * 1000,
    idToken: typeof record.id_token === "string" ? record.id_token : undefined,
  };
}

export async function exchangeCodexAuthorizationCode(
  code: string,
  verifier: string,
  config: CodexOAuthConfig = getCodexOAuthConfig(),
): Promise<CodexTokens> {
  return postToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  }), config);
}

export async function refreshCodexToken(
  refreshToken: string,
  config: CodexOAuthConfig = getCodexOAuthConfig(),
): Promise<CodexTokens> {
  if (!refreshToken.trim()) {
    throw new CodexOAuthError("Codex refresh token is missing; re-authentication is required.", {
      code: "missing_refresh_token",
      reloginRequired: true,
    });
  }
  return postToken(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  }), config, refreshToken);
}

export function createCodexAuthorizationFlow(
  config: CodexOAuthConfig = getCodexOAuthConfig(),
): { verifier: string; state: string; url: string } {
  const { verifier, challenge } = generatePKCE();
  const state = createOAuthState();
  return { verifier, state, url: buildCodexAuthorizationUrl(config, state, challenge) };
}

export function codexOAuthErrorMessage(error: unknown): string {
  if (error instanceof CodexOAuthError) return error.message;
  return "Codex OAuth request failed; re-authentication may be required.";
}
