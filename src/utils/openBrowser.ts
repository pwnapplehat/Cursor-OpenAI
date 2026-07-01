import { spawn } from "node:child_process";
import type { Logger } from "../logger";

/**
 * Best-effort cross-platform "open this URL in the default browser". Used to
 * drop non-technical users straight into the setup wizard/dashboard on
 * startup instead of expecting them to know to open a browser themselves.
 * Never throws - a missing/unavailable browser (e.g. inside a headless
 * Docker container) should never take down the server.
 */
export function openBrowser(url: string, log: Logger): void {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", '""', url], { detached: true, stdio: "ignore", shell: false }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    log.debug({ err, url }, "could not auto-open the browser (this is harmless - open the URL manually)");
  }
}
