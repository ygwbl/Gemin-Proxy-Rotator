// OpenCode Zen interactive login flow.

import { createInterface } from "node:readline";
import type { AccountConfig } from "../../types.js";
import { OPENCODE_ZEN_MODELS_URL } from "./catalog.js";
import { defaultAccountEmail, OPENCODE_ZEN_PROVIDER_ID } from "./credentials.js";

function askQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function validateApiKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(OPENCODE_ZEN_MODELS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runLogin(): Promise<AccountConfig> {
  console.log("=== Tuxevil Rotator - Add OpenCode Zen Account ===");
  console.log();

  const apiKey = await askQuestion("Paste your OpenCode Zen API key: ");

  if (!apiKey) {
    console.error("No API key provided.");
    process.exit(1);
  }

  console.log("Validating API key against opencode.ai/zen...");
  const result = await validateApiKey(apiKey);
  if (!result.ok) {
    console.error(`API key validation failed: ${result.error}`);
    process.exit(1);
  }

  const email = defaultAccountEmail(apiKey);
  const defaultLabel = email.split("@")[0];
  const label = await askQuestion(`Account label (default: ${defaultLabel}): `);

  return {
    email,
    credentials: [
      {
        provider: OPENCODE_ZEN_PROVIDER_ID,
        apiKey,
      },
    ],
    label: label || defaultLabel,
  };
}
