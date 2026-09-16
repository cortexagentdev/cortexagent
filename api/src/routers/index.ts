import { router } from "../trpc.ts";
import { alertRouter } from "./alert.ts";
import { authRouter } from "./auth.ts";
import { feeRouter } from "./fee.ts";
import { lensRouter } from "./lens.ts";
import { signalRouter } from "./signal.ts";
import { statsRouter } from "./stats.ts";
import { themeRouter } from "./theme.ts";
import { universeRouter } from "./universe.ts";
import { vaultRouter } from "./vault.ts";
import { watchlistRouter } from "./watchlist.ts";

export const appRouter = router({
  alert: alertRouter,
  auth: authRouter,
  fee: feeRouter,
  lens: lensRouter,
  signal: signalRouter,
  stats: statsRouter,
  theme: themeRouter,
  universe: universeRouter,
  vault: vaultRouter,
  watchlist: watchlistRouter,
});

export type AppRouter = typeof appRouter;
