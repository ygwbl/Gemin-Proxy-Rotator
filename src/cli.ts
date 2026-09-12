// CLI entry point for tuxevil-rotator
// Usage:
//   tuxevil-rotator start     Start the proxy
//   tuxevil-rotator login     Add a new account
//   tuxevil-rotator status    Show account status
//   tuxevil-rotator keys      Manage virtual API keys

import {
  getConfigDir,
  getLastLegacyMigrationReport,
  migrateLegacyConfig,
} from "./paths.js";

const args = process.argv
  .slice(2)
  .filter(
    (a) =>
      !a.startsWith("--config-dir") &&
      a !== process.argv[process.argv.indexOf("--config-dir") + 1],
  );
const command = args[0] || "start";

console.log(`Config dir: ${getConfigDir()}`);
console.log();


switch (command) {
  case "start": {
    // Dynamic import to avoid loading everything for help
    const { main } = await import("./index.js");
    await main();
    break;
  }
  case "login": {
    // Mirror the environment of the installed systemd service unit
    // (TUXEVIL_ROTATOR_*, ANTIGRAVITY_*, DATABASE_URL) into this CLI process so
    // login talks to the same backend store the running service uses. Without
    // this, login would write to the on-disk accounts.json while the service
    // (configured with TUXEVIL_ROTATOR_DATABASE_URL) reads from PostgreSQL.
    const { loadSystemdEnvironment } = await import("./systemd-env.js");
    loadSystemdEnvironment();
    const { initDb } = await import("./db-store.js");
    await initDb();
    const providerFlag = process.argv.indexOf("--provider");
    const providerId =
      providerFlag >= 0 && process.argv[providerFlag + 1]
        ? process.argv[providerFlag + 1]
        : undefined;
    const importFlag = process.argv.indexOf("--import");
    if (providerId === "openai-codex" && importFlag >= 0) {
      const importPath = process.argv[importFlag + 1];
      if (!importPath || importPath.startsWith("--")) {
        console.error("Usage: tuxevil-rotator login --provider openai-codex --import <auth.json>");
        process.exitCode = 1;
        break;
      }
      const { addAccountToConfig } = await import("./account-store.js");
      const { importCodexAuthFile } = await import("./providers/openai-codex/login.js");
      try {
        const imported = await importCodexAuthFile(importPath);
        const { isNew } = await addAccountToConfig(imported.account);
        console.log(`  ${isNew ? "Added" : "Updated"} ${imported.account.email} in Codex provider credentials`);
      } catch (err) {
        console.error(`Codex import failed: ${err instanceof Error ? err.message : "invalid auth.json"}`);
        process.exitCode = 1;
      }
    } else {
      const { runLogin } = await import("./login.js");
      await runLogin(providerId);
    }
    break;
  }
  case "import": {
    const { initDb, closeDb } = await import("./db-store.js");
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const {
      ensurePiAuthConfig,
      ensurePiModelsConfig,
      importAccountsToConfig,
    } = await import("./account-store.js");
    const sourcePath = resolve(
      args[1] || join(homedir(), ".config", "antigravity", "accounts.json"),
    );

    try {
      await initDb();
      const parsed = JSON.parse(await readFile(sourcePath, "utf-8")) as unknown;
      const result = await importAccountsToConfig(parsed);
      if (result.added + result.updated > 0) {
        await ensurePiModelsConfig();
        await ensurePiAuthConfig();
      }
      console.log(`Imported ${result.added + result.updated} account(s) from ${sourcePath}`);
      console.log(`  Added:     ${result.added}`);
      console.log(`  Updated:   ${result.updated}`);
      console.log(`  Unchanged: ${result.unchanged}`);
      console.log(`  Skipped:   ${result.skipped}`);
      for (const error of result.errors) console.error(`  Skipped: ${error}`);
      if (result.errors.length > 0) process.exitCode = 1;
    } catch (err) {
      console.error(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
    break;
  }
  case "status": {
    const { initDb, closeDb } = await import("./db-store.js");
    const {
      getConfiguredAdminToken,
      readPersistedAdminToken,
      setPersistedAdminToken,
    } = await import("./admin-auth.js");
    try {
      await initDb();
      setPersistedAdminToken(readPersistedAdminToken());
      const token = getConfiguredAdminToken();
      const port = 51200;
      const res = await fetch(`http://localhost:${port}/api/status`, {
        headers: token ? { "X-Rotator-Admin-Token": token } : {},
      });
      if (res.status === 401) {
        console.error(
          "Rotator status is protected and the local admin token was rejected.",
        );
        process.exitCode = 1;
        break;
      }
      if (!res.ok) {
        console.error(`Rotator status returned HTTP ${res.status}`);
        process.exitCode = 1;
        break;
      }
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.error("Rotator is not running or unreachable on port 51200");
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
    break;
  }
  case "doctor": {
    const { initDb } = await import("./db-store.js");
    await initDb();
    const { printDoctorReport, runDoctor } = await import("./doctor.js");
    const result = await runDoctor();
    printDoctorReport(result);
    process.exit(result.ok ? 0 : 1);
    break;
  }
  case "migrate": {
    const report =
      getLastLegacyMigrationReport() ?? migrateLegacyConfig(getConfigDir());
    console.log("Legacy migration complete.");
    console.log(`  Target: ${report.targetDir}`);
    if (report.copied.length > 0) {
      console.log(`  Copied: ${report.copied.join(", ")}`);
    }
    if (report.skipped.length > 0) {
      console.log(`  Already present: ${report.skipped.join(", ")}`);
    }
    if (report.errors.length > 0) {
      console.error("  Errors:");
      for (const error of report.errors) console.error(`    ${error}`);
      process.exitCode = 1;
    } else if (report.copied.length === 0 && report.skipped.length === 0) {
      console.log("  No legacy files were found; nothing to migrate.");
    }
    console.log("  Legacy files were not removed.");
    break;
  }
  case "keys": {
    const initDb = (await import("./db-store.js")).initDb;
    const { isDbConfigured } = await import("./db-store.js");
    if (!isDbConfigured()) {
      console.error("Virtual keys require PostgreSQL. Set TUXEVIL_ROTATOR_DATABASE_URL.");
      process.exit(1);
    }
    await initDb();
    const { runKeyMigrations } = await import("./key-migrations.js");
    await runKeyMigrations();

    const {
      listVirtualKeys,
      generateVirtualKey,
      deleteVirtualKey,
    } = await import("./virtual-keys.js");

    const subAction = args[1] || "list";

    if (subAction === "list") {
      const keys = await listVirtualKeys();
      if (keys.length === 0) {
        console.log("No virtual keys found. Use 'tuxevil-rotator keys generate' to create one.");
      } else {
        console.log(`${keys.length} virtual key(s):`);
        console.log("─".repeat(70));
        for (const k of keys) {
          console.log(`  Alias:     ${k.keyAlias}`);
          console.log(`  Key:       ${k.keyName}`);
          console.log(`  Hash:      ${k.tokenHash}`);
          console.log(`  User:      ${k.userId || "(any)"}`);
          console.log(`  Models:    ${k.models && k.models.length > 0 ? k.models.join(", ") : "(all)"}`);
          console.log(`  Status:    ${k.blocked ? "BLOCKED" : "active"}`);
          console.log(`  Created:   ${k.createdAt}`);
          console.log(`  Last used: ${k.lastActive || "never"}`);
          console.log("─".repeat(70));
        }
      }
      process.exit(0);
    }

    if (subAction === "generate") {
      const aliasIdx = args.indexOf("--alias");
      const alias = aliasIdx >= 0 ? args[aliasIdx + 1] : null;
      if (!alias) {
        console.error("Missing --alias <name> (e.g. --alias cursor-agent)");
        process.exit(1);
      }

      const userIdIdx = args.indexOf("--user-id");
      const userId = userIdIdx >= 0 ? args[userIdIdx + 1] : undefined;

      const modelsIdx = args.indexOf("--models");
      const modelsRaw = modelsIdx >= 0 ? args[modelsIdx + 1] : undefined;
      const models = modelsRaw ? modelsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

      const { rawKey, key } = await generateVirtualKey({
        alias,
        userId,
        models,
        createdBy: "cli",
      });

      console.log("Virtual key generated successfully!");
      console.log(`  Alias:   ${key.keyAlias}`);
      console.log(`  Raw key: ${rawKey}`);
      console.log();
      console.log("⚠ Save this key now — it cannot be retrieved later.");
      console.log("  Use Authorization: Bearer " + rawKey);
      console.log("  Or x-rotator-key: " + rawKey);
      process.exit(0);
    }

    if (subAction === "delete") {
      const hash = args[2];
      if (!hash) {
        console.error("Usage: tuxevil-rotator keys delete <hash>");
        process.exit(1);
      }
      const deleted = await deleteVirtualKey(hash);
      if (deleted) {
        console.log("Virtual key deleted.");
      } else {
        console.error("Virtual key not found.");
        process.exit(1);
      }
      process.exit(0);
    }

    console.error(`Unknown subcommand: ${subAction}`);
    console.log("Usage: tuxevil-rotator keys [list|generate|delete]");
    process.exit(1);
  }
  break;
  default:
    console.log("Tuxevil Rotator");
    console.log();
    console.log("Usage:");
    console.log("  tuxevil-rotator start     Start the proxy (default)");
    console.log("  tuxevil-rotator login     Add an account (use --provider openai-codex for Codex OAuth)");
    console.log("  tuxevil-rotator login --provider openai-codex --import <auth.json>");
    console.log(
      "  tuxevil-rotator import    Import Google/Pi accounts from JSON (default: ~/.config/antigravity/accounts.json)",
    );
    console.log(
      "  tuxevil-rotator status    Show account status (JSON)",
    );
    console.log(
      "  tuxevil-rotator doctor    Validate config and local state",
    );
    console.log(
      "  tuxevil-rotator migrate   Copy legacy config files safely",
    );
    console.log("  tuxevil-rotator keys     Manage virtual API keys");
    console.log(
      "                                 list   - List all virtual keys",
    );
    console.log(
      "                                 generate --alias <name> [--user-id <id>] [--models m1,m2]",
    );
    console.log(
      "                                 delete <hash> - Delete a virtual key",
    );
    console.log();
    console.log("Options:");
    console.log(
      "  --config-dir <path>    Config directory (default: ~/.tuxevil-rotator/)",
    );
    console.log(
      "  routingPolicy          timer-first | tier-first | quota-first | hybrid | sequential-quota | sticky-quota (accounts.json)",
    );
    console.log();
    console.log("Environment:");
    console.log("  TUXEVIL_ROTATOR_DIR         Config directory override");
    process.exit(command === "help" || command === "--help" ? 0 : 1);
}
