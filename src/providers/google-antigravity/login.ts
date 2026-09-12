// Google Antigravity interactive login flow (OAuth2 + PKCE).
// 1. Opens OAuth URL -> user pastes redirect URL
// 2. Exchanges the code, resolves the user email + Cloud Code project
// Returns a ready-to-persist AccountConfig.

import { createInterface } from "node:readline";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import {
  buildAuthUrl,
  discoverProject,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  getUserEmail,
  getOAuthClientConfig,
} from "./oauth.js";
import type { AccountConfig } from "../../types.js";

function parseRedirectUrl(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    return {};
  }
}

function askQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const LOCAL_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface LocalOAuthCallbackOptions {
  redirectUri?: string;
  timeoutMs?: number;
  port?: number;
  onListening?: (port: number) => void;
}

export type LocalOAuthCallbackResult =
  | { code: string; state: string }
  | { error: string; errorDescription?: string };

export class OAuthCallbackUnavailableError extends Error {}
export class OAuthCallbackTimeoutError extends Error {}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function callbackPage(title: string, message: string, closeWindow = false): string {
  const closeScript = closeWindow
    ? "<script>window.close();</script>"
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${closeScript}</body></html>`;
}

function isLoopbackRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) &&
      url.pathname === "/oauth-callback"
    );
  } catch {
    return false;
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Listen only on loopback for the CLI OAuth redirect. The server is always
 * closed by the finally block, including callback errors and timeout.
 */
export async function waitForLocalOAuthCallback(
  expectedState: string,
  options: LocalOAuthCallbackOptions = {},
): Promise<LocalOAuthCallbackResult> {
  const redirectUri = options.redirectUri ?? getOAuthClientConfig().redirectUri;
  if (!isLoopbackRedirectUri(redirectUri)) {
    throw new OAuthCallbackUnavailableError(
      "The configured OAuth redirect is not a loopback callback.",
    );
  }

  const redirect = new URL(redirectUri);
  const host = redirect.hostname === "::1" || redirect.hostname === "[::1]"
    ? "::1"
    : "127.0.0.1";
  const urlHost = host === "::1" ? `[${host}]` : host;
  const port = options.port ?? Number(redirect.port || 51121);
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${urlHost}:${port}`);
    if (req.method !== "GET" || requestUrl.pathname !== redirect.pathname) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackPage("Not Found", "This callback endpoint is not available."));
      return;
    }

    const callbackState = requestUrl.searchParams.get("state");
    if (callbackState !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackPage("Callback Rejected", "The OAuth state did not match this login session."));
      return;
    }

    const error = requestUrl.searchParams.get("error");
    const errorDescription = requestUrl.searchParams.get("error_description") ?? undefined;
    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackPage("Sign-In Cancelled", errorDescription || error, true));
      finish({ error, ...(errorDescription ? { errorDescription } : {}) });
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackPage("Missing Code", "Google did not return an authorization code."));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(callbackPage("Sign-In Complete", "You can close this window and return to the terminal.", true));
    finish({ code, state: callbackState });
  });

  let finish: (result: LocalOAuthCallbackResult) => void = () => undefined;
  const result = new Promise<LocalOAuthCallbackResult>((resolve) => {
    finish = resolve;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        const address = server.address();
        const listeningPort = typeof address === "object" && address ? address.port : port;
        options.onListening?.(listeningPort);
        resolve();
      });
    });
  } catch {
    await closeServer(server);
    throw new OAuthCallbackUnavailableError(
      "Could not start the local OAuth callback. Check whether port 51121 is already in use.",
    );
  }

  try {
    const timeoutMs = options.timeoutMs ?? LOCAL_CALLBACK_TIMEOUT_MS;
    return await Promise.race([
      result,
      new Promise<LocalOAuthCallbackResult>((_, reject) => {
        const timeout = setTimeout(() => {
          reject(new OAuthCallbackTimeoutError("The local OAuth callback timed out."));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    await closeServer(server);
  }
}

function shouldOpenBrowser(): boolean {
  return ["1", "true", "yes"].includes(
    (process.env.TUXEVIL_OPEN_BROWSER ?? "").trim().toLowerCase(),
  );
}

/** Open a URL without a shell; the auth URL contains no access/refresh token. */
export function openOAuthBrowser(url: string): boolean {
  const browser = process.env.BROWSER?.trim();
  const command = browser ||
    (process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open");
  const args = browser
    ? [url]
    : process.platform === "win32"
      ? ["/c", "start", "", url]
      : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function runLogin(): Promise<AccountConfig> {
  console.log("=== Tuxevil Rotator - Add Google Antigravity Account ===");
  console.log();

  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const authUrl = buildAuthUrl(state, challenge);

  console.log("1. Open this URL in your browser:");
  console.log();
  console.log(authUrl);
  console.log();
  console.log("2. Complete the Google sign-in.");
  console.log("3. Return to this terminal after Google redirects to the configured callback.");
  console.log();

  const redirectUri = getOAuthClientConfig().redirectUri;
  let parsed: { code?: string; state?: string };
  if (isLoopbackRedirectUri(redirectUri)) {
    if (shouldOpenBrowser() && openOAuthBrowser(authUrl)) {
      console.log("Opened the OAuth page in your browser.");
    }
    try {
      const callback = await waitForLocalOAuthCallback(state, { redirectUri });
      if ("error" in callback) {
        throw new Error(callback.errorDescription || callback.error);
      }
      parsed = callback;
    } catch (err) {
      if (!(err instanceof OAuthCallbackUnavailableError)) throw err;
      console.log(err.message);
      const redirectUrl = await askQuestion("Paste the redirect URL: ");
      parsed = parseRedirectUrl(redirectUrl);
    }
  } else {
    const redirectUrl = await askQuestion("Paste the redirect URL: ");
    if (!redirectUrl) throw new Error("No URL provided.");
    parsed = parseRedirectUrl(redirectUrl);
  }

  if (!parsed.code) {
    throw new Error("Could not extract authorization code from the URL.");
  }

  if (parsed.state !== state) {
    throw new Error("State mismatch - the URL does not match this login session.");
  }

  console.log();
  console.log("Exchanging code for tokens...");
  const tokenData = await exchangeAuthorizationCode(parsed.code, verifier);

  console.log("Getting user info...");
  const email = await getUserEmail(tokenData.accessToken);

  console.log("Discovering project...");
  const project = await discoverProject(tokenData.accessToken);

  const label = email ? email.split("@")[0] : "Account";
  return {
    provider: "google-antigravity",
    email: email || "unknown@gmail.com",
    refreshToken: tokenData.refreshToken,
    projectId: project.projectId,
    projectSource: project.source,
    label,
  };
}
