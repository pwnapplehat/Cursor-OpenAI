import type { Server } from "node:http";
import type { Express } from "express";
import type { Logger } from "../logger";

export interface ListenResult {
  server: Server;
  port: number;
}

function isAddressInUseError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
}

export function listenOnce(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const candidate = app.listen(port, host);
    candidate.once("listening", () => resolve(candidate));
    candidate.once("error", (err: unknown) => reject(err));
  });
}

/**
 * Binds `app` to `preferredPort`, or - only when that exact port is already
 * taken by something else - the next few ports above it, so a stray process
 * squatting on the default port doesn't stop the gateway from starting at
 * all. This is deliberately only used for the *initial* boot, where nobody
 * explicitly chose the port; the admin dashboard's port/host change
 * (`ConfigStore.update` + `onServerRebindNeeded`) intentionally does NOT use
 * this - a user who explicitly picks a port for the running server should
 * get a clear failure if it's unavailable, not a silent substitution.
 *
 * Any bind failure that isn't "address in use" (bad host, permission denied
 * on a privileged port, etc.) is not retried and surfaces immediately -
 * silently trying other ports wouldn't fix those and would just hide a real
 * configuration problem behind a confusing "it started on a random port".
 */
export async function listenWithPortFallback(
  app: Express,
  preferredPort: number,
  host: string,
  log: Logger,
  maxAttempts = 20,
): Promise<ListenResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidatePort = preferredPort + attempt;
    try {
      const server = await listenOnce(app, candidatePort, host);
      if (candidatePort !== preferredPort) {
        log.warn({ preferredPort, port: candidatePort }, `Port ${preferredPort} was already in use - started on ${candidatePort} instead.`);
      }
      return { server, port: candidatePort };
    } catch (err) {
      if (!isAddressInUseError(err) || attempt === maxAttempts - 1) throw err;
    }
  }
  throw new Error(`Could not find an available port starting from ${preferredPort}`);
}
