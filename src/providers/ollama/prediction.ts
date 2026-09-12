// Ported from the ollama-rotator project (same author) into the
// tuxevil-rotator provider layer.
// Exhaustion prediction for Ollama Cloud quota pools.
//
// Ollama Cloud reports each pool as a usage FRACTION (0..1) — never absolute
// tokens. The calibration burns (tools/usage-calibration.ts, 2026-08-09)
// measured the real per-model pool sizes, so a pool's remaining tokens can
// be estimated as `(1 - fraction) * budget` and, combined with the recent
// token burn rate, projected to an exhaustion time.
//
// This module is pure: it has no I/O, no timers and no state beyond the
// per-account sliding token meters, so it can be unit-tested directly.

export interface PoolBudgetEntry {
  /** Estimated tokens for a full 100% session (5h) pool. */
  sessionTokens: number;
  /** Estimated tokens for a full 100% weekly (7d) pool. */
  weeklyTokens: number;
}

// Measured on 2026-08-09 with controlled burns (see docs/usage-calibration.md).
// Two gpt-oss:20b runs on different accounts agreed within ~1%, so these are
// per-account, per-model budgets, not per-IP.
// minimax-m3 removed 2026-08-30: moved to subscription tier (HTTP 402 on free).
export const CALIBRATED_MODEL_BUDGETS: Readonly<Record<string, PoolBudgetEntry>> = {
  "gpt-oss:20b": { sessionTokens: 1_560_000, weeklyTokens: 4_210_000 },
  "gemma4:31b": { sessionTokens: 1_150_000, weeklyTokens: 3_110_000 },
  "nemotron-3-nano:30b": { sessionTokens: 1_930_000, weeklyTokens: 5_190_000 },
  "gpt-oss:120b": { sessionTokens: 760_000, weeklyTokens: 2_050_000 },
  "nemotron-3-super": { sessionTokens: 740_000, weeklyTokens: 2_010_000 },
  "nemotron-3-ultra": { sessionTokens: 120_000, weeklyTokens: 330_000 },
};

// Uncalibrated models get the tier-1 average rounded down so prediction
// errs on the side of caution (earlier exhaustion, earlier rotation).
export const FALLBACK_POOL_BUDGET: PoolBudgetEntry = {
  sessionTokens: 1_400_000,
  weeklyTokens: 3_800_000,
};

export interface PoolExhaustionEstimate {
  pool: "session" | "weekly";
  /** Full-pool budget in tokens (from calibration or fallback). */
  budgetTokens: number;
  /** Estimated tokens already consumed (fraction * budget). */
  usedTokens: number;
  /** Estimated tokens remaining. */
  remainingTokens: number;
  /** Recent burn rate in tokens per minute (windowed). */
  tokensPerMinute: number;
  /** Minutes until the pool runs out; null when there is no recent burn. */
  minutesRemaining: number | null;
  /** Epoch ms at which the pool is projected to run out; null when unknown. */
  exhaustedAtMs: number | null;
}

export interface ExhaustionPrediction {
  /** Stable key `<email>::<model>` used for the meters. */
  key: string;
  model: string;
  /** Whether the budget came from calibration or the fallback table. */
  budgetsFrom: "calibrated" | "fallback";
  session: PoolExhaustionEstimate;
  weekly: PoolExhaustionEstimate;
  /** The pool that runs out first; null when neither rate is known. */
  soonest: PoolExhaustionEstimate | null;
}

interface ModelMeter {
  /** minute-bucket ts -> tokens (minuteKey = floor(nowMs / 60_000)). */
  minutes: Map<number, number>;
  /** Buckets older than this are dropped on record. */
  readonly windowMs: number;
}

const WINDOW_MS = 15 * 60_000;
const MIN_RATE_MINUTES = 1;

export class UsagePredictor {
  private readonly budgets: Readonly<Record<string, PoolBudgetEntry>>;
  private readonly meters = new Map<string, ModelMeter>();

  constructor(budgets: Readonly<Record<string, PoolBudgetEntry>> = CALIBRATED_MODEL_BUDGETS) {
    this.budgets = budgets;
  }

  /** Resolve a model's budget, falling back to the size tag and then to FALLBACK. */
  getBudget(model: string): { budget: PoolBudgetEntry; from: "calibrated" | "fallback" } {
    const exact = this.budgets[model];
    if (exact) return { budget: exact, from: "calibrated" };
    // Variants like "gpt-oss:120b-preview" share the size-tag budget of
    // "gpt-oss:120b" (same weights, dated/preview suffixes only).
    const [family, tag] = model.split(":");
    if (family && tag) {
      const sizeTag = tag.split("-")[0];
      const stripped = `${family}:${sizeTag}`;
      if (stripped !== model && this.budgets[stripped]) {
        return { budget: this.budgets[stripped], from: "calibrated" };
      }
    }
    return { budget: FALLBACK_POOL_BUDGET, from: "fallback" };
  }

  /** Record a completed request's token usage for an account+model. */
  recordUsage(
    accountEmail: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    nowMs: number = Date.now(),
  ): void {
    const tokens = Math.max(0, inputTokens) + Math.max(0, outputTokens);
    if (tokens <= 0) return;
    const key = `${accountEmail.toLowerCase()}::${model}`;
    let meter = this.meters.get(key);
    if (!meter) {
      meter = { minutes: new Map(), windowMs: WINDOW_MS };
      this.meters.set(key, meter);
    }
    const minuteKey = Math.floor(nowMs / 60_000);
    meter.minutes.set(minuteKey, (meter.minutes.get(minuteKey) ?? 0) + tokens);
    this.prune(meter, nowMs);
  }

  /** Project exhaustion for a pool given the measured usage fraction (0..1). */
  predict(
    accountEmail: string,
    model: string,
    sessionFractionUsed: number,
    weeklyFractionUsed: number,
    nowMs: number = Date.now(),
  ): ExhaustionPrediction {
    const { budget, from } = this.getBudget(model);
    const key = `${accountEmail.toLowerCase()}::${model}`;
    const rate = this.burnRate(key, nowMs);
    const estimate = (
      pool: "session" | "weekly",
      fraction: number,
    ): PoolExhaustionEstimate => {
      const budgetTokens = pool === "session" ? budget.sessionTokens : budget.weeklyTokens;
      const usedFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
      const usedTokens = Math.round(usedFraction * budgetTokens);
      const remainingTokens = Math.max(0, budgetTokens - usedTokens);
      const minutesRemaining = rate > 0 ? remainingTokens / rate : null;
      return {
        pool,
        budgetTokens,
        usedTokens,
        remainingTokens,
        tokensPerMinute: rate,
        minutesRemaining,
        exhaustedAtMs: minutesRemaining !== null ? nowMs + minutesRemaining * 60_000 : null,
      };
    };
    const session = estimate("session", sessionFractionUsed);
    const weekly = estimate("weekly", weeklyFractionUsed);
    const soonest = [session, weekly].reduce<PoolExhaustionEstimate | null>(
      (a, e) => {
        if (e.minutesRemaining === null) return a;
        if (a === null || (a.minutesRemaining !== null && e.minutesRemaining < a.minutesRemaining)) {
          return e;
        }
        return a;
      },
      null,
    );
    return { key, model, budgetsFrom: from, session, weekly, soonest };
  }

  private burnRate(key: string, _nowMs: number): number {
    const meter = this.meters.get(key);
    if (!meter || meter.minutes.size === 0) return 0;
    const keys = [...meter.minutes.keys()];
    const first = Math.min(...keys);
    const last = Math.max(...keys);
    let total = 0;
    for (const tokens of meter.minutes.values()) total += tokens;
    const minutes = Math.max(MIN_RATE_MINUTES, (last - first + 1));
    return total / minutes;
  }

  private prune(meter: ModelMeter, nowMs: number): void {
    const cutoff = nowMs - meter.windowMs;
    for (const minuteKey of meter.minutes.keys()) {
      if (minuteKey * 60_000 < cutoff) meter.minutes.delete(minuteKey);
    }
  }
}
