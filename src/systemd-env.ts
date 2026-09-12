// Load environment variables from the installed systemd service unit so the
// CLI talks to the same backend data store (and OAuth client) as the running
// rotator service.
//
// The service is configured via systemd drop-ins such as:
//   /etc/systemd/system/tuxevil-rotator.service
//   /etc/systemd/system/tuxevil-rotator.service.d/database.conf
//   /etc/systemd/system/tuxevil-rotator.service.d/oauth.conf
//
// When invoked from a plain shell (e.g. `tuxevil-rotator login`) those
// Environment=/EnvironmentFile= lines are NOT present in the CLI process, so
// the CLI used to fall back to the on-disk FileSettingsRepository while the
// service wrote to PostgreSQL. This module mirrors the service environment
// into the CLI process so both stay consistent.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Keys that are safe/meaningful to mirror from the systemd unit. */
const MIRROR_PREFIXES = ["TUXEVIL_ROTATOR_", "PI_ROTATOR_", "ANTIGRAVITY_", "OLLAMA_"];
const MIRROR_EXACT = new Set(["DATABASE_URL", "ENCRYPTION_KEY"]);

export interface SystemdEnvironmentSource {
  /** Systemd base directories to search (defaults to the distro standard set). */
  unitDirs?: string[];
  /** Service name including the .service suffix. */
  serviceName?: string;
}

export function isMirrorableKey(key: string): boolean {
  if (MIRROR_EXACT.has(key)) return true;
  return MIRROR_PREFIXES.some((p) => key.startsWith(p));
}

/** Split a systemd Environment= value into individual KEY=VALUE assignments. */
export function tokenizeEnvAssignments(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Parse a systemd EnvironmentFile line (path with optional -/@ prefix). */
export function stripEnvironmentFilePrefix(path: string): string {
  let p = path.trim();
  while (p.startsWith("-") || p.startsWith("@")) p = p.slice(1);
  return p.trim();
}

/** Parse `KEY=VALUE` lines from a dotenv-style environment file. */
export function parseEnvironmentFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const withoutExport = line.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Parse a systemd unit file into a list of env assignments and env file paths. */
export function parseSystemdUnit(
  content: string,
): { env: Record<string, string>; envFiles: string[] } {
  const env: Record<string, string> = {};
  const envFiles: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("Environment=")) {
      for (const token of tokenizeEnvAssignments(line.slice("Environment=".length).trim())) {
        const eq = token.indexOf("=");
        if (eq <= 0) continue;
        const key = token.slice(0, eq).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = token.slice(eq + 1);
      }
    } else if (line.startsWith("EnvironmentFile=")) {
      const rawFile = stripInlineComment(line.slice("EnvironmentFile=".length));
      const file = stripEnvironmentFilePrefix(rawFile);
      if (file) envFiles.push(file);
    }
  }
  return { env, envFiles };
}

function stripInlineComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Locate the unit file and its drop-in .conf files for a service. */
export function findSystemdUnitFiles(
  unitDirs: string[],
  serviceName: string,
): { baseDir: string | null; dropins: string[] } {
  let baseDir: string | null = null;
  for (const dir of unitDirs) {
    if (existsSync(join(dir, serviceName))) {
      baseDir = dir;
      break;
    }
  }
  if (!baseDir) return { baseDir: null, dropins: [] };

  const dropinDir = join(baseDir, `${serviceName}.d`);
  const dropins: string[] = [];
  if (existsSync(dropinDir)) {
    for (const entry of readdirSync(dropinDir).sort()) {
      if (entry.endsWith(".conf")) dropins.push(join(dropinDir, entry));
    }
  }
  return { baseDir, dropins };
}

/**
 * Load the systemd unit environment and mirror it into `env` (defaults to
 * process.env). Only keys that are not already present are applied so that an
 * explicitly-provided value (e.g. from the shell) always wins.
 *
 * Returns the list of environment variable names that were applied.
 */
export function loadSystemdEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  source: SystemdEnvironmentSource = {},
): string[] {
  const unitDirs = source.unitDirs ?? [
    "/etc/systemd/system",
    "/usr/lib/systemd/system",
    "/lib/systemd/system",
  ];
  const serviceName =
    source.serviceName ??
    (findSystemdUnitFiles(unitDirs, "tuxevil-rotator.service").baseDir
      ? "tuxevil-rotator.service"
      : "pi-antigravity-rotator.service");
  const applied: string[] = [];

  const { baseDir, dropins } = findSystemdUnitFiles(unitDirs, serviceName);
  if (!baseDir) return applied;

  // Systemd applies the base unit first, then drop-ins in lexicographic order.
  const unitFiles = [join(baseDir, serviceName), ...dropins];

  const envFiles: string[] = [];
  const assignments: Record<string, string> = {};
  for (const file of unitFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSystemdUnit(content);
    Object.assign(assignments, parsed.env);
    envFiles.push(...parsed.envFiles);
  }

  const resolvedEnv: Record<string, string> = {};
  for (const file of [...new Set(envFiles)]) {
    if (!existsSync(file)) continue;
    try {
      Object.assign(resolvedEnv, parseEnvironmentFile(readFileSync(file, "utf8")));
    } catch {
      // Skip unreadable env files.
    }
  }

  const merged: Record<string, string> = { ...assignments, ...resolvedEnv };
  for (const key of Object.keys(merged)) {
    if (!isMirrorableKey(key)) continue;
    if (env[key] !== undefined) continue;
    env[key] = merged[key];
    applied.push(key);
  }
  return applied;
}