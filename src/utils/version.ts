import fs from "node:fs";
import path from "node:path";

let cachedVersion: string | undefined;

/**
 * Reads this package's own version from `package.json` at runtime (not
 * bundled in at build time), so the admin dashboard/CLI can display exactly
 * what's actually installed. Resolved relative to this compiled file's own
 * location (`dist/utils/version.js` -> project root), the same pattern
 * `server.ts` already uses for locating `public/` - works regardless of the
 * process's current working directory.
 */
export function getGatewayVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.join(__dirname, "..", "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version = typeof parsed === "object" && parsed !== null && "version" in parsed ? (parsed as { version?: unknown }).version : undefined;
    cachedVersion = typeof version === "string" && version.length > 0 ? version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
