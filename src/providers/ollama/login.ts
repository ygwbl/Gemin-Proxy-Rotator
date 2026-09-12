// Ollama Cloud login flow: paste an API key, validate it against the
// usage endpoint, and derive a stable account email.
//
// Ported from the ollama-rotator project (same author) into the
// tuxevil-rotator provider layer.

import { createInterface } from "node:readline";
import type { AccountConfig } from "../../types.js";
import { defaultAccountEmail, validateApiKey } from "./api-key-validation.js";

function askQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive Ollama Cloud login: ask for an API key, validate it against
 * `GET /api/usage`, and return an account config (email derived from the
 * key suffix unless the user overrides it).
 */
export async function runLogin(): Promise<AccountConfig> {
  console.log("=== Tuxevil Rotator - Add Ollama Cloud Account ===");
  console.log();

  const apiKey = await askQuestion(
    "Paste your Ollama Cloud API key (ollama.com/settings/keys): ",
  );

  if (!apiKey) {
    console.error("No API key provided.");
    process.exit(1);
  }

  console.log("Validating API key against ollama.com...");
  const result = await validateApiKey(apiKey);
  if (!result.ok) {
    console.error(`API key validation failed: ${result.error}`);
    process.exit(1);
  }

  const label = await askQuestion(
    `Account label (default: ${defaultAccountEmail(apiKey).split("@")[0]}): `,
  );

  return {
    email: defaultAccountEmail(apiKey),
    apiKey,
    label: label || defaultAccountEmail(apiKey).split("@")[0],
  };
}