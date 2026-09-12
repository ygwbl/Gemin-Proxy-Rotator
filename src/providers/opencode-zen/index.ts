// OpenCode Zen provider adapter.

import type { ProviderAdapter, ProviderFeatures } from "../adapter.js";
import { runLogin } from "./login.js";
import { getOpenCodeZenApiKey, validateCredentials, OPENCODE_ZEN_PROVIDER_ID } from "./credentials.js";
import { forwardRequest, OpenCodeZenSseAccumulator, getBenchmarkSpec } from "./forward.js";
import { fetchOpenCodeZenQuota } from "./quota.js";
import { isOpenCodeZenModel } from "./catalog.js";
import type { AccountRuntime } from "../../types.js";

const OPENCODE_ZEN_TIER_RANKING = {
  free: 0,
  unknown: 1,
};

export const opencodeZenAdapter: ProviderAdapter = {
  id: OPENCODE_ZEN_PROVIDER_ID,
  displayName: "OpenCode Zen",
  credentialKind: "api-key",
  tierRanking: OPENCODE_ZEN_TIER_RANKING,

  features: {
    circuitBreakers: true,
    concurrencyLimits: true,
    proactiveRotation: false,
  } satisfies ProviderFeatures,

  runLogin,

  validateCredentials,

  hasValidCredentials(account: AccountRuntime): boolean {
    const key = getOpenCodeZenApiKey(account.config);
    return typeof key === "string" && key.trim().length > 0;
  },

  async ensureValidToken(): Promise<void> {},

  getAuthHeader(account: AccountRuntime): string {
    const key = getOpenCodeZenApiKey(account.config) ?? "";
    return `Bearer ${key}`;
  },

  shouldRetryOnQuotaExhaustion(): boolean {
    return true;
  },

  async fetchQuota(account: AccountRuntime, ctx): Promise<void> {
    await fetchOpenCodeZenQuota(account, ctx);
  },

  forwardRequest,

  createStreamAccumulator: () => new OpenCodeZenSseAccumulator(),

  getKickstartModelForPool(): string | undefined {
    return undefined;
  },

  ownsModel(model: string): boolean {
    return isOpenCodeZenModel(model);
  },

  getPoolKey(model: string): string {
    return `${OPENCODE_ZEN_PROVIDER_ID}:${model}`;
  },

  getBenchmark() {
    return getBenchmarkSpec();
  },
};

export { OPENCODE_ZEN_PROVIDER_ID };
