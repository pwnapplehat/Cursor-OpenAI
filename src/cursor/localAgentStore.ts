import fs from "node:fs";
import path from "node:path";
import { Cursor, JsonlLocalAgentStore } from "@cursor/sdk";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";

/**
 * Explicitly configures a JSONL-backed local agent store as the SDK-wide
 * default, instead of relying on `@cursor/sdk`'s own storage auto-detection.
 *
 * Confirmed by real cross-platform testing (not assumption): the SDK's
 * default local storage tries Node's built-in `node:sqlite` module first,
 * which only exists in Node >= 22.13. On any earlier Node version - including
 * this gateway's own declared minimum, Node 18.17 - every local agent
 * operation fails outright with "Default local agent storage requires the
 * built-in node:sqlite module", regardless of OS. This was caught by
 * actually running the gateway on Node 18.20.5 on Linux, not by reasoning
 * about it - `npm run build`/`typecheck`/`test` all passed fine, since none
 * of them create a real agent; only an actual chat completion request
 * surfaced it.
 *
 * Configuring `JsonlLocalAgentStore` unconditionally (rather than only as a
 * fallback for old Node) sidesteps the entire class of bug: it has zero
 * native dependencies and behaves identically on every supported Node
 * version (18.17+) and OS.
 */
export function configureLocalAgentStore(config: AppConfig, log: Logger): void {
  const storeDir = path.join(path.dirname(config.cursorWorkdirRoot), "agent-store");
  fs.mkdirSync(storeDir, { recursive: true });
  Cursor.configure({ local: { store: new JsonlLocalAgentStore(storeDir) } });
  log.debug({ storeDir }, "configured JSONL local agent store (Node-version-independent, no native dependencies)");
}
