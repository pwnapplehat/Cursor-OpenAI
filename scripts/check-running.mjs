/**
 * Pre-flight for start.bat / start.sh: is a gateway from THIS folder already
 * running (e.g. via the autostart/ toolkit, or another terminal)?
 *
 * Prints the port to stdout and exits 0 when a healthy instance answers on
 * the configured port; prints nothing and exits 1 otherwise. The launchers
 * use this to open the existing dashboard instead of starting a second
 * gateway - without it, `npm start` would hit EADDRINUSE and the gateway's
 * own initial-boot port fallback would silently bind the NEXT port up,
 * leaving two gateways for one repo (clients pointed at the configured port
 * keep talking to the old one while the new window shows a different one).
 *
 * Port resolution mirrors the gateway's own precedence exactly
 * (src/config.ts + src/configStore.ts): .cursor-gateway/settings.json "port"
 * (the dashboard-persisted overlay - wins) -> last PORT= assignment in .env
 * (quotes/inline comments tolerated) -> 8787.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolvePort() {
  try {
    const settings = JSON.parse(readFileSync(path.join(repoRoot, ".cursor-gateway", "settings.json"), "utf8"));
    const candidate = Number(settings?.port);
    if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) return candidate;
  } catch {
    /* no overlay, or unreadable - same as the gateway, fall through to .env */
  }
  try {
    const env = readFileSync(path.join(repoRoot, ".env"), "utf8");
    const matches = [...env.matchAll(/^\s*PORT\s*=\s*["']?(\d{1,5})["']?\s*(?:#.*)?$/gm)];
    if (matches.length > 0) {
      const candidate = Number(matches[matches.length - 1][1]);
      if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) return candidate;
    }
  } catch {
    /* no .env yet (first run) */
  }
  return 8787;
}

const port = resolvePort();

// NOTE: exit via process.exitCode + natural termination, never process.exit():
// forcing an exit right after fetch() races undici's socket cleanup on Windows
// and crashes with a native libuv assertion (the CLI hit this exact bug -
// see the "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" entry in
// the README's Testing section - and this script reproduced it when tested
// with process.exit()).
process.exitCode = 1;
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
  if (response.ok) {
    const body = await response.json();
    // Shape check so an unrelated app squatting on the port with its own
    // /health endpoint isn't mistaken for this gateway.
    if (body && body.status === "ok" && typeof body.sessions === "object" && typeof body.concurrency === "object") {
      process.stdout.write(String(port));
      process.exitCode = 0;
    }
  }
} catch {
  /* not running / not reachable - the normal "go ahead and start it" case */
}
