// OpenCode Zen request forwarding and SSE stream accumulation.

import type { AccountRuntime } from "../../types.js";
import type { ForwardedResponse, RequestBody } from "../../proxy.js";
import type { StreamAccumulator, TokenUsage } from "../adapter.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import type { RequestInitWithDispatcher } from "../../fetch-with-retry.js";
import { getOpenCodeZenApiKey, OPENCODE_ZEN_PROVIDER_ID } from "./credentials.js";
import { OPENCODE_ZEN_CHAT_URL } from "./catalog.js";
import { isRecord } from "../../compat/schema-sanitizer.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
  "via",
]);

export function buildOpenCodeZenPayload(body: RequestBody): Record<string, unknown> {
  const request = isRecord(body.request) ? body.request : {};
  // OpenCode Zen does not support the `developer` role (an OpenAI o1/o3 extension).
  // Normalise it to `system` so the upstream deserialises the request correctly.
  const messages = Array.isArray(request.messages)
    ? (request.messages as unknown[]).map((msg) => {
        if (isRecord(msg) && msg.role === "developer") {
          return { ...msg, role: "system" };
        }
        return msg;
      })
    : request.messages;
  return {
    ...request,
    ...(messages !== request.messages ? { messages } : {}),
    model: body.model,
    stream: Boolean(request.stream),
  };
}

export async function forwardRequest(
  account: AccountRuntime,
  body: RequestBody,
  originalHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<ForwardedResponse> {
  const payload = buildOpenCodeZenPayload(body);
  const apiKey = getOpenCodeZenApiKey(account.config) ?? "";

  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(originalHeaders)) {
    const lower = key.toLowerCase();
    if (
      !HOP_BY_HOP.has(lower) &&
      lower !== "authorization" &&
      lower !== "content-type" &&
      lower !== "accept"
    ) {
      forwardHeaders[key] = value;
    }
  }

  forwardHeaders["Authorization"] = `Bearer ${apiKey}`;
  forwardHeaders["Content-Type"] = "application/json";
  forwardHeaders["Accept"] = payload.stream === true ? "text/event-stream" : "application/json";

  const endpoint = OPENCODE_ZEN_CHAT_URL;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(payload),
    signal,
    dispatcher: getAccountProxyDispatcher(account, OPENCODE_ZEN_PROVIDER_ID),
  } as RequestInitWithDispatcher);

  return { response, endpoint };
}

function extractUsageFromRecord(record: Record<string, unknown>): TokenUsage | null {
  const usage = isRecord(record.usage) ? record.usage : record;
  const inputTokens =
    typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : 0;
  const outputTokens =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : 0;

  return inputTokens > 0 || outputTokens > 0
    ? { inputTokens, outputTokens }
    : null;
}

export class OpenCodeZenSseAccumulator implements StreamAccumulator {
  private buffer = "";
  private accumulatedText = "";
  private usage: TokenUsage | null = null;

  append(chunkText: string): TokenUsage | null {
    this.buffer += chunkText;
    let newlyFound: TokenUsage | null = null;
    let newlineIdx = this.buffer.indexOf("\n");

    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;

            // Extract delta text if present
            if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
              const choice = parsed.choices[0];
              if (isRecord(choice) && isRecord(choice.delta)) {
                const content = choice.delta.content;
                if (typeof content === "string" && this.accumulatedText.length < 100000) {
                  this.accumulatedText += content;
                }
              }
            }

            const extractedUsage = extractUsageFromRecord(parsed);
            if (extractedUsage) {
              this.usage = extractedUsage;
              newlyFound = extractedUsage;
            }
          } catch {
            // Ignore malformed SSE lines
          }
        }
      }

      newlineIdx = this.buffer.indexOf("\n");
    }

    return newlyFound;
  }

  getText(): string {
    return this.accumulatedText;
  }

  final(): TokenUsage | null {
    if (this.buffer.trim()) {
      this.append(`${this.buffer}\n`);
    }
    return this.usage;
  }
}

const BENCHMARK_MODEL = "deepseek-v4-flash-free";

export function getBenchmarkSpec(): {
  body: RequestBody;
  parseUsage(raw: string): { outputTokens: number } | null;
  parseText(raw: string): string;
} {
  return {
    body: {
      project: "",
      model: BENCHMARK_MODEL,
      request: {
        model: BENCHMARK_MODEL,
        messages: [{ role: "user", content: "Reply with: OK" }],
        stream: false,
        max_tokens: 16,
      },
    },
    parseUsage(raw: string) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const usage = extractUsageFromRecord(parsed);
        return usage ? { outputTokens: usage.outputTokens } : null;
      } catch {
        return null;
      }
    },
    parseText(raw: string) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
          const choice = parsed.choices[0];
          if (isRecord(choice) && isRecord(choice.message)) {
            return typeof choice.message.content === "string"
              ? choice.message.content
              : "";
          }
        }
        return raw.slice(0, 1000);
      } catch {
        return raw.slice(0, 1000);
      }
    },
  };
}
