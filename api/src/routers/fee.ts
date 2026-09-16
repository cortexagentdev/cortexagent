import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { z } from "zod";

import { feeControllerAbi, keylessVaultAbi } from "../chain/abis/index.ts";
import { executionPublicClient } from "../chain/client.ts";
import { getExecutionContext } from "../execution/context.ts";
import { BPS, PROTOCOL_CUT_BPS } from "../chain/theme-policy.ts";
import { multicallRead, type MulticallItem } from "../chain/multicall.ts";
import { decodeAccrual, decodeNavIndicative, decodeUint, fromWad } from "../chain/vault-reads.ts";
import { themeTokens } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import { getSession } from "../lib/session.ts";
import { publicProcedure, router } from "../trpc.ts";

/**
 * `feeRouter` (BE-27). What a theme's creator has earned, and at what rate.
 *
 * C2 is testnet only (locked decision 5), so the `FeeController` read here goes
 * through the RHC testnet client (chain 46630) against the address the BE-26
 * indexer recorded in `theme_tokens.spec.feeController`.
 *
 * ## The fee streams, it is not charged at mint
 *
 * `FeeController` accrues in SHARES against tracking AUM over wall-clock time:
 * `supply × rate × dt`, a management fee funded by pro-rata dilution. Nothing in
 * it keys off a mint or a redeem. P0-4 already corrected that confusion in the
 * UI copy and this router must not reintroduce it, so `creatorFeeBps` appears
 * here split into its per-year `creatorBps` and `protocolBps` slices, never as a
 * charge on a deposit.
 *
 * ## `accruedUsd` is computed here, not on chain
 *
 * The contract reads no oracle by design (a stale feed can never stall accrual),
 * so the USD figure is `accruedShares × navPerShare` and it is this router that
 * multiplies. When NAV cannot be read at all the figure is null, never 0: an
 * unpriceable accrual is not an empty one (global do-not 2). When it is priced
 * off `navIndicative()` or the market is closed, `indicative` says so.
 *
 * A public read: what a creator earns from a fully-backed public vault is a
 * public fact, on the same footing as its NAV.
 */

const log = logger.child({ module: "fee-router" });

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// `PROTOCOL_CUT_BPS` (the protocol's share of every accrued fee, in bps OF THE
// FEE) and `BPS` are mirrors of `FeeController`'s own constants. They live in
// `chain/theme-policy.ts` with every other mirrored number and are asserted
// against the compiled artifact by `bun run contracts:check` (BE-29 scope 8).
// Used here only to reconstruct the split when the on-chain views cannot be read.

const tokenIdInput = z
  .object({
    tokenId: z
      .string()
      .trim()
      .regex(ADDRESS_RE, "Invalid theme token id")
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export interface CreatorAccrual {
  /** Lifetime gross accrual, in theme-token shares, human units. */
  accruedShares: number;
  /** `accruedShares × navPerShare`. Null when NAV could not be read at all. */
  accruedUsd: number | null;
  /** The creator's slice of AUM per year, bps. */
  creatorBps: number;
  /** The protocol's slice of AUM per year, bps. Sums with `creatorBps` to the
   *  vault's `creatorFeeBps`, with no rounding leak. */
  protocolBps: number;
  /** True when `accruedUsd` is priced off an indicative NAV, or the market is
   *  closed. The share figure is exact either way. */
  indicative: boolean;
}

export const feeRouter = router({
  /**
   * A theme's streaming-fee accrual and the rate it accrues at. One
   * `Multicall3` read pinned to a single testnet block, so the shares figure and
   * the NAV that prices it come from the same chain state.
   */
  creatorAccrual: publicProcedure
    .input(tokenIdInput)
    .query(async ({ ctx, input }): Promise<CreatorAccrual> => {
      const [row] = await ctx.db
        .select()
        .from(themeTokens)
        .where(
          and(
            eq(themeTokens.id, input.tokenId),
            eq(themeTokens.canonical, true),
            eq(
              themeTokens.executionDeploymentId,
              (await getExecutionContext())?.manifest.deploymentId ?? "",
            ),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Theme token not found" });
      }

      const controllerAddress = row.spec.feeController;
      if (!ADDRESS_RE.test(controllerAddress)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This theme has no fee controller",
        });
      }
      const controller = getAddress(controllerAddress);
      const vault = getAddress(row.vault);

      const calls = [
        { address: controller, abi: feeControllerAbi, functionName: "accrual" },
        { address: controller, abi: feeControllerAbi, functionName: "creatorBps" },
        { address: controller, abi: feeControllerAbi, functionName: "protocolBps" },
        // `navPerShare()` reverts when a constituent feed is outside its
        // liveness bound. That is the designed safe failure, so the indicative
        // read rides along in the same batch (global do-not 1).
        { address: vault, abi: keylessVaultAbi, functionName: "navPerShare" },
        { address: vault, abi: keylessVaultAbi, functionName: "navIndicative" },
      ] as const;

      let results: MulticallItem<unknown>[];
      try {
        const blockNumber = await executionPublicClient.getBlockNumber();
        results = (await multicallRead(calls, {
          client: executionPublicClient,
          blockNumber,
        })) as unknown as MulticallItem<unknown>[];
      } catch (err) {
        log.warn("fee controller read failed", { tokenId: row.id, err });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The fee controller is temporarily unreachable. Try again in a moment.",
        });
      }

      const accrual = decodeAccrual(results[0]);
      if (accrual === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Fee accrual is not available for this theme",
        });
      }

      const creatorBpsRaw = decodeUint(results[1]);
      const protocolBpsRaw = decodeUint(results[2]);
      const strictNav = decodeUint(results[3]);
      const navInd = decodeNavIndicative(results[4]);

      // The split is fixed in the bytecode: the protocol cut rounds down and the
      // creator takes the exact remainder. Reconstructing it from the deploy
      // event's `creatorFeeBps` gives the same two numbers if the views revert.
      const protocolBps =
        protocolBpsRaw === null
          ? Math.floor((row.creatorFeeBps * PROTOCOL_CUT_BPS) / BPS)
          : Number(protocolBpsRaw);
      const creatorBps =
        creatorBpsRaw === null ? row.creatorFeeBps - protocolBps : Number(creatorBpsRaw);

      const accruedShares = Number(accrual.accrued) / 10 ** row.spec.decimals;
      const strictNavPerShare = strictNav === null ? null : fromWad(strictNav);
      // `navIndicative()` answers `(0, true)` on zero supply. Zero shares have
      // accrued in that case anyway, and 0 is not a price.
      const indicativeNavPerShare =
        navInd !== null && navInd.value > 0n ? fromWad(navInd.value) : null;
      const navPerShare = strictNavPerShare ?? indicativeNavPerShare;

      const marketClosed = getSession(new Date()) !== "rth";

      return {
        accruedShares,
        accruedUsd: navPerShare === null ? null : accruedShares * navPerShare,
        creatorBps,
        protocolBps,
        indicative: marketClosed || strictNavPerShare === null,
      };
    }),
});
