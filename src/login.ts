// Generic login orchestrator: delegates the interactive flow to the selected
// provider adapter and persists the resulting account.
// Usage: npm run login [--provider <id>]   (default: google-antigravity)

import {
  addAccountToConfig,
  ensurePiAuthConfig,
  ensurePiModelsConfig,
  loadOrCreateAccountsConfig,
} from "./account-store.js";
import type { AccountConfig } from "./types.js";
import { getAccountsPath } from "./paths.js";
import { getProviderAdapter, DEFAULT_PROVIDER } from "./providers/registry.js";

const ACCOUNTS_FILE = getAccountsPath();

export async function runLogin(providerId?: string): Promise<void> {
  const provider = providerId || DEFAULT_PROVIDER;
  const adapter = getProviderAdapter(provider);

  console.log(`Adding a ${adapter.displayName} account via ${adapter.credentialKind} flow.`);

  const entry: AccountConfig = await adapter.runLogin();
  entry.provider = provider;

  const { isNew } = await addAccountToConfig(entry);
  console.log(`  ${isNew ? "Added" : "Updated"} ${entry.email} in ${ACCOUNTS_FILE}`);

  // The Google flow also keeps the Pi IDE config in sync.
  if (provider === "google-antigravity") {
    await ensurePiModelsConfig();
    await ensurePiAuthConfig();
  }

  const config = loadOrCreateAccountsConfig();
  console.log();
  console.log(`Done. ${config.accounts.length} account(s) configured:`);
  for (const a of config.accounts) {
    const providers =
      (a.credentials ?? [])
        .map((c) => c.provider)
        .join("+") || a.provider ||
      DEFAULT_PROVIDER;
    console.log(`  ${a.label || a.email} (${a.email}) [${providers}]`);
  }
  console.log();
  console.log("Run 'npm start' to start the proxy.");
}