/**
 * Must be the very first import in the entrypoint, before anything else
 * (including `@cursor/sdk`) is imported.
 *
 * Confirmed by real testing on Node 18.20.5 (not assumption): Node only
 * exposes the WebCrypto API as the bare global `crypto` (no import needed)
 * starting in Node 19+; on Node 18 it exists solely as `require("node:crypto").webcrypto`
 * unless the process is started with the experimental `--experimental-global-webcrypto`
 * flag. Some code inside `@cursor/sdk`'s dependency chain references the bare
 * global directly, which throws "crypto is not defined" the first time an
 * agent actually runs (it doesn't surface at startup or in typecheck/build/
 * test - only on a real request) on Node 18, on any OS.
 *
 * This polyfills the global using Node's own WebCrypto implementation (the
 * same one newer Node versions expose by default), so behavior is identical
 * whether or not the runtime already provides it - a no-op on Node 19+/20+/
 * 22+/24+, and a correct, non-experimental-flag-dependent fix on 18.x.
 */
import { webcrypto } from "node:crypto";

const globalWithCrypto = globalThis as typeof globalThis & { crypto?: typeof webcrypto };
if (typeof globalWithCrypto.crypto === "undefined") {
  globalWithCrypto.crypto = webcrypto;
}
