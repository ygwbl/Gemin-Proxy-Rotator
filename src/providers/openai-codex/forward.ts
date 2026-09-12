import type { AccountRuntime, ProviderCredential } from "../../types.js";
import type { ForwardedResponse, RequestBody } from "../../proxy.js";
import type { StreamAccumulator, TokenUsage } from "../adapter.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import type { RequestInitWithDispatcher } from "../../fetch-with-retry.js";
import { getCodexAccountId, getCodexCredential, getCodexTokenState } from "./credentials.js";
import { DEFAULT_CODEX_BASE_URL, CODEX_PROVIDER_ID } from "./oauth.js";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-real-ip", "forwarded", "via",
]);
const DEFAULT_CODEX_INSTRUCTIONS = "You are a helpful assistant.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codexFunctionTool(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "function") return value;
  const source = isRecord(value.function) ? value.function : value;
  const tool: Record<string, unknown> = {
    type: "function",
    name: source.name,
  };
  for (const field of ["description", "parameters", "strict"]) {
    if (source[field] !== undefined) tool[field] = source[field];
  }
  return tool;
}

function codexToolChoice(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "function") return value;
  if (isRecord(value.function)) {
    return { type: "function", name: value.function.name };
  }
  return value;
}

export function codexBaseUrl(): string {
  return (process.env.CODEX_BASE_URL?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/$/, "");
}

export function codexResponsesEndpoint(): string {
  const base = codexBaseUrl();
  return base.endsWith("/responses") ? base : `${base}/responses`;
}

/** Remove stateful Responses fields that reference a backend item Codex cannot recover. */
export function sanitizeCodexResponsesRequest(
  request: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...request, model };
  sanitized.instructions = codexInstructions(sanitized.instructions);
  sanitized.store = false;
  sanitized.stream = true;
  if (typeof sanitized.input === "string") {
    sanitized.input = [{
      role: "user",
      content: [{ type: "input_text", text: sanitized.input }],
    }];
  }
  if (Array.isArray(sanitized.tools)) {
    sanitized.tools = sanitized.tools.map(codexFunctionTool);
  }
  if (sanitized.tool_choice !== undefined) {
    sanitized.tool_choice = codexToolChoice(sanitized.tool_choice);
  }
  delete sanitized.previous_response_id;
  delete sanitized.conversation;
  delete sanitized.input_items;
  delete sanitized.background;
  delete sanitized.prompt_cache_key;
  delete sanitized.max_output_tokens;
  // The proxy owns streaming; this field is not accepted by the internal endpoint.
  delete sanitized.stream_options;
  return sanitized;
}

function codexInstructions(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return DEFAULT_CODEX_INSTRUCTIONS;
}

/** Build a native Codex Responses payload from the common proxy request envelope. */
export function buildCodexPayload(body: RequestBody): Record<string, unknown> {
  const request = isRecord(body.request) ? body.request : {};
  return sanitizeCodexResponsesRequest(request, body.model);
}

function authToken(account: AccountRuntime): string {
  const token = getCodexTokenState(account).accessToken;
  if (!token) throw new Error("Codex access token is unavailable; re-authenticate");
  return token;
}

function forwardHeaders(
  originalHeaders: Record<string, string>,
  account: AccountRuntime,
  payload: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = { ...originalHeaders };
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === "authorization" ||
      lower === "x-goog-api-key" ||
      lower === "x-goog-user-project" ||
      lower === "x-goog-user-agent" ||
      lower.startsWith("x-ollama-") ||
      lower === "chatgpt-account-id" ||
      lower === "accept" ||
      lower === "content-type" ||
      lower === "user-agent" ||
      lower === "openai-beta"
    ) delete headers[key];
  }
  headers.Authorization = `Bearer ${authToken(account)}`;
  const accountId = getCodexAccountId(account.config);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  headers["Content-Type"] = "application/json";
  headers.Accept = payload.stream === false ? "application/json" : "text/event-stream";
  headers["OpenAI-Beta"] = "responses=v1";
  headers["User-Agent"] = "tuxevil-rotator/openai-codex";
  return headers;
}

export async function forwardCodexRequest(
  account: AccountRuntime,
  body: RequestBody,
  originalHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<ForwardedResponse> {
  const payload = buildCodexPayload(body);
  const response = await fetch(codexResponsesEndpoint(), {
    method: "POST",
    headers: forwardHeaders(originalHeaders, account, payload),
    body: JSON.stringify(payload),
    signal,
    dispatcher: getAccountProxyDispatcher(account, CODEX_PROVIDER_ID),
  } as RequestInitWithDispatcher);
  return { response, endpoint: codexResponsesEndpoint() };
}

function usageFromRecord(record: Record<string, unknown>): TokenUsage | null {
  const usage = isRecord(record.usage)
    ? record.usage
    : isRecord(record.response) && isRecord(record.response.usage)
      ? record.response.usage
      : record;
  const input = typeof usage.input_tokens === "number"
    ? usage.input_tokens
    : typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : 0;
  const output = typeof usage.output_tokens === "number"
    ? usage.output_tokens
    : typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : 0;
  return input > 0 || output > 0 ? { inputTokens: input, outputTokens: output } : null;
}

export function extractCodexUsage(raw: string): TokenUsage | null {
  let found: TokenUsage | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      found = usageFromRecord(parsed) ?? found;
    } catch {
      // Ignore malformed SSE chunks; a later response.completed chunk can carry usage.
    }
  }
  return found;
}

export class CodexSseAccumulator implements StreamAccumulator {
  private buffer = "";
  private text = "";
  private usage: TokenUsage | null = null;

  append(chunkText: string): TokenUsage | null {
    this.buffer += chunkText;
    let newline = this.buffer.indexOf("\n");
    let newlyFound: TokenUsage | null = null;
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          const delta = typeof parsed.delta === "string" ? parsed.delta : "";
          if (delta) this.text += delta;
          const usage = usageFromRecord(parsed);
          if (usage) {
            this.usage = usage;
            newlyFound = usage;
          }
        } catch {
          // Ignore malformed events.
        }
      }
      newline = this.buffer.indexOf("\n");
    }
    return newlyFound;
  }

  getText(): string { return this.text; }
  final(): TokenUsage | null {
    if (this.buffer.trim()) this.append(`${this.buffer}\n`);
    return this.usage;
  }
}

export function createCodexStreamAccumulator(): CodexSseAccumulator {
  return new CodexSseAccumulator();
}

export function getCodexAuthCredential(account: AccountRuntime): ProviderCredential | undefined {
  return getCodexCredential(account.config);
}
