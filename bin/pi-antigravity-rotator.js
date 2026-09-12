#!/usr/bin/env node
// Legacy shim for `pi-antigravity-rotator` (v2.x and earlier).
//
// The binary was renamed to `tuxevil-rotator` in v3.0. This shim keeps
// existing scripts, systemd units, docker images, and agent configs that
// still invoke `pi-antigravity-rotator` working without changes.
//
// It forwards every argument to the new `tuxevil-rotator` binary, which
// in turn dispatches into the same `src/cli.ts` entry point. There is
// no duplicated logic here — the shim is intentionally a thin wrapper.
//
// Removal: this shim will be removed in a future major version. A
// deprecation warning is printed once per process to stderr so existing
// users notice the rename without breaking their automation.

if (!process.env.PI_ANTIGRAVITY_ROTATOR_SHIM_QUIET) {
  process.stderr.write(
    "[deprecation] `pi-antigravity-rotator` has been renamed to `tuxevil-rotator`. " +
      "This shim forwards to the new binary and will be removed in a future major version. " +
      "See https://github.com/tuxevil/tuxevil-rotator/blob/main/docs/migrating-from-pi-antigravity-rotator.md\n",
  );
}

import("tsx/esm/api").then(({ register }) => {
  register();
  return import("../src/cli.ts");
});
