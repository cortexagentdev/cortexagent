import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";

import { readSession, type Session } from "./auth/session.ts";
import { db, type Db } from "./db/client.ts";
import { redis, type RedisClient } from "./lib/redis.ts";

export type { Session };

export interface Context {
  db: Db;
  redis: RedisClient;
  /**
   * The signed-in caller, or null. Populated from the session cookie (BE-21).
   * `protectedProcedure` rejects when it is null; public routers ignore it.
   */
  session: Session | null;
  /**
   * Response headers for the current request. `authRouter` appends the session
   * `Set-Cookie` here; nothing else should need to write to it.
   */
  resHeaders: Headers;
}

export async function createContext(opts: FetchCreateContextFnOptions): Promise<Context> {
  const session = await readSession(opts.req.headers.get("cookie"));
  return { db, redis, session, resHeaders: opts.resHeaders };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const middleware = t.middleware;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

/**
 * Open to anonymous callers. Research surfaces (Signal Feed, Lenses, Universe)
 * are wallet-free by design (locked decision 1).
 */
export const publicProcedure = t.procedure;

/** Requires a session. Watchlist, alerts, settings and vault writes only. */
export const protectedProcedure = t.procedure.use(
  middleware(({ ctx, next }) => {
    if (!ctx.session) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Sign in with your wallet to continue",
      });
    }
    return next({ ctx: { ...ctx, session: ctx.session } });
  }),
);
