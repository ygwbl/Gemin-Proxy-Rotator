import type { Config } from "./types.js";

type ExposureConfig = Pick<Config, "bindHost" | "proxyPort">;

export function isLoopbackBindHost(bindHost?: string | null): boolean {
  const host = (bindHost || "0.0.0.0").trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function getProxyExposureWarning(config: ExposureConfig): string | null {
  const bindHost = config.bindHost || "0.0.0.0";
  if (isLoopbackBindHost(bindHost)) return null;
  return (
    `Native and /v1 compatibility proxy routes are unauthenticated by design and are listening on ${bindHost}:${config.proxyPort}. ` +
    "Restrict this port to localhost/LAN, a firewall, or a trusted reverse proxy, or set bindHost to 127.0.0.1 for local-only use."
  );
}
