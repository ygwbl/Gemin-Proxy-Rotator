// Environment variable resolution with legacy fallback.
//
// The service is branded "tuxevil-rotator": all configuration env vars use
// the TUXEVIL_ROTATOR_ prefix. For backward compatibility with existing
// deployments, every read falls back to the legacy PI_ROTATOR_ prefix.

export function rotatorEnv(name: string): string | undefined {
  const value = process.env[`TUXEVIL_ROTATOR_${name}`];
  if (value !== undefined) return value;
  return process.env[`PI_ROTATOR_${name}`];
}

export function rotatorEnvOr(name: string, fallback: string): string {
  return rotatorEnv(name) ?? fallback;
}