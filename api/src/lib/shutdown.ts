import { logger } from "./logger.ts";

/**
 * Docker sends SIGTERM on `compose down` and waits 10s by default before SIGKILL.
 * Budget under that so a slow step still gets logged instead of being killed mid-write.
 */
const SHUTDOWN_TIMEOUT_MS = 9_000;

export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

/**
 * Runs `steps` in order on SIGTERM or SIGINT, then exits.
 *
 * Order matters and is the caller's responsibility: stop accepting new work
 * first, then drain what is in flight, then close connections. A failing step
 * does not abort the rest, otherwise one stuck client leaks every other one.
 */
export function installShutdownHandlers(steps: ShutdownStep[]): void {
  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      // A second signal while draining means someone is impatient. Honour it.
      logger.warn("second shutdown signal, exiting now", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("shutting down", { signal });

    const killer = setTimeout(() => {
      logger.error("shutdown timed out, exiting anyway", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    killer.unref();

    let exitCode = 0;
    for (const step of steps) {
      try {
        await step.run();
        logger.debug("shutdown step complete", { step: step.name });
      } catch (err) {
        exitCode = 1;
        logger.error("shutdown step failed", { step: step.name, err });
      }
    }

    clearTimeout(killer);
    logger.info("shutdown complete", { exitCode });
    process.exit(exitCode);
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}
