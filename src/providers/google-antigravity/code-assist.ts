import {
	ANTIGRAVITY_ENDPOINTS,
	REQUEST_CLIENT_METADATA,
	REQUEST_GOOG_API_CLIENT,
	REQUEST_USER_AGENT,
} from "../../types.js";
import type { AccountRuntime } from "../../types.js";
import type { ForwardedResponse } from "../../proxy.js";
import { fetchWithRetry } from "../../fetch-with-retry.js";
import { DEFAULT_PROVIDER, getProviderProjectId } from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";

export const CODE_ASSIST_ACTIONS = [
	"loadCodeAssist",
	"fetchAvailableModels",
	"onboardUser",
	"listExperiments",
	"countTokens",
	"retrieveUserQuota",
	"retrieveUserQuotaSummary",
] as const;

export type CodeAssistAction = (typeof CODE_ASSIST_ACTIONS)[number];

export function isCodeAssistAction(value: string): value is CodeAssistAction {
	return (CODE_ASSIST_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObjectBody(action: CodeAssistAction, body: unknown): Record<string, unknown> {
	if (!isRecord(body)) {
		throw new Error(`Code Assist ${action} requires a JSON object body`);
	}
	return body;
}

export function validateCodeAssistPayload(
	action: CodeAssistAction,
	body: unknown,
): void {
	const object = requireObjectBody(action, body);
	if (action === "onboardUser") {
		if (typeof object.tier_id !== "string" || object.tier_id.trim() === "") {
			throw new Error("Code Assist onboardUser requires tier_id");
		}
	}
	if (action === "countTokens") {
		if (typeof object.model !== "string" || object.model.trim() === "") {
			throw new Error("Code Assist countTokens requires model");
		}
		if (!("request" in object)) {
			throw new Error("Code Assist countTokens requires request");
		}
	}
}

function buildHeaders(
	account: AccountRuntime,
	originalHeaders: Record<string, string>,
): Record<string, string> {
	const headers: Record<string, string> = { ...originalHeaders };
	const hopByHop = new Set([
		"authorization",
		"connection",
		"content-length",
		"host",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailers",
		"transfer-encoding",
		"upgrade",
		"user-agent",
		"x-goog-api-client",
		"client-metadata",
	]);
	for (const key of Object.keys(headers)) {
		if (hopByHop.has(key.toLowerCase())) delete headers[key];
	}
	headers.Authorization = `Bearer ${account.accessToken ?? ""}`;
	headers["Content-Type"] = "application/json";
	headers.Accept = "application/json";
	headers["User-Agent"] = REQUEST_USER_AGENT;
	headers["X-Goog-Api-Client"] = REQUEST_GOOG_API_CLIENT;
	headers["Client-Metadata"] = REQUEST_CLIENT_METADATA;
	return headers;
}

function buildUpstreamBody(
	account: AccountRuntime,
	action: CodeAssistAction,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const projectScoped = new Set([
		"fetchAvailableModels",
		"countTokens",
		"retrieveUserQuota",
		"retrieveUserQuotaSummary",
	]);
	if (!projectScoped.has(action)) return { ...body };
	const projectId = getProviderProjectId(account.config, DEFAULT_PROVIDER);
	if (!projectId) {
		throw new Error(`Code Assist ${action} requires the active account projectId`);
	}
	return { ...body, project: projectId };
}

export async function forwardCodeAssistRequest(
	account: AccountRuntime,
	action: CodeAssistAction,
	body: unknown,
	originalHeaders: Record<string, string>,
	signal?: AbortSignal,
): Promise<ForwardedResponse> {
	validateCodeAssistPayload(action, body);
	const requestBody = buildUpstreamBody(
		account,
		action,
		body as Record<string, unknown>,
	);
	const headers = buildHeaders(account, originalHeaders);
	let lastError: unknown;

	for (let index = 0; index < ANTIGRAVITY_ENDPOINTS.length; index++) {
		const endpoint = ANTIGRAVITY_ENDPOINTS[index];
		try {
			const response = await fetchWithRetry(
				`${endpoint}/v1internal:${action}`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(requestBody),
					signal,
					dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
					retries: 0,
					timeoutMs: 10_000,
				},
			);
			if (
				(response.status === 401 ||
					response.status === 403 ||
					response.status === 404) &&
				index < ANTIGRAVITY_ENDPOINTS.length - 1
			) {
				await response.body?.cancel().catch(() => undefined);
				continue;
			}
			return { response, endpoint };
		} catch (err) {
			lastError = err;
			if (signal?.aborted) throw err;
			if (index < ANTIGRAVITY_ENDPOINTS.length - 1) continue;
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error("All Code Assist endpoints failed");
}
