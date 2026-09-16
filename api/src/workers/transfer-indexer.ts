/**
 * The forward-only `Transfer` indexer (BE-15).
 *
 * `spec/CortexBackend.md` PART 3, "Flow / liquidity / holder signals", and
 * locked decision 9. HOLDER_CONCENTRATION is the one C1 signal that genuinely
 * needs event logs; every other kind ships from free REST plus direct chain
 * reads.
 *
 * ## Forward only, never genesis
 *
 * The spec's wider architecture mentions an archive node and `eth_getLogs` from
 * genesis. That is explicitly a C3 concern and it is not done here: RHC was at
 * ~30.17M blocks at survey time, a scan across that range is the single most
 * expensive operation in the whole design, and free tiers meter it hard (locked
 * decision 7). Instead this indexer records the chain head at first run into
 * `indexer_state.startBlock` and only ever moves forward from it. The 30-day
 * holder baseline fills in over a month; until it does, `holder-concentration`
 * emits at LOW confidence and says how short the baseline is.
 *
 * ## Crash safety
 *
 * Each block chunk is applied in one transaction: the `holder_balances` deltas
 * and the `indexer_state.lastBlock` bump commit together. A crash mid-chunk
 * rolls back both, and the next run resumes from `lastBlock + 1`. There is no
 * window in which balances have moved but the cursor has not, or vice versa, so
 * a restart never gaps a block or double-counts a transfer.
 *
 * ## Reorgs
 *
 * The indexer stays `TRANSFER_INDEXER_CONFIRMATIONS` blocks behind head, so a
 * shallow reorg is resolved before its logs are applied. A deeper reorg than
 * that is out of scope for a testnet-adjacent C1 read path.
 *
 * ## What the balances are
 *
 * `holder_balances.balance` is the running sum of raw transfer deltas since
 * `startBlock`. Because indexing is forward-only it is the net change since
 * index start, not the absolute holding. `holder-concentration` treats it as a
 * candidate list and reads the authoritative `balanceOfUI()` / `totalSupplyUI()`
 * for the actual share math (see `signals/holder-concentration.ts`).
 */

import { eq, sql } from "drizzle-orm";
import { getAddress, parseAbiItem, type Address } from "viem";

import { logsClient, publicClient } from "../chain/client.ts";
import { countRpcRequests } from "../chain/rpc-metrics.ts";
import { db } from "../db/client.ts";
import { indexerState, universe } from "../db/schema.ts";
import { env } from "../env.ts";
import { logger } from "../lib/logger.ts";
import { redis } from "../lib/redis.ts";

const log = logger.child({ module: "transfer-indexer" });

/** BullMQ repeatable interval. Frequent enough to keep the holder baseline
 *  current, cheap because a caught-up cycle is one `eth_blockNumber`. */
export const TRANSFER_INDEX_INTERVAL_MS = 60_000;

/** The `indexer_state` row this worker owns. */
export const TRANSFER_INDEXER = "transfer";

const CONFIRMATIONS = env.TRANSFER_INDEXER_CONFIRMATIONS;
const CHUNK_BLOCKS = env.TRANSFER_INDEXER_CHUNK_BLOCKS;
const MAX_CHUNKS_PER_RUN = env.TRANSFER_INDEXER_MAX_CHUNKS_PER_RUN;
const RPC_PACING_MS = env.TRANSFER_INDEXER_RPC_PACING_MS;

/** Rate-limit retries per cycle before the durable cursor waits for the next tick. */
const MAX_RATE_LIMIT_RETRIES = env.TRANSFER_INDEXER_MAX_RATE_LIMIT_RETRIES;

// postgres-js/Bun rejects a statement with more than 65,534 parameters. Each
// holder-balance row contributes four parameters, so leave headroom and split
// large chunks while keeping all batches in the same database transaction.
const MAX_HOLDER_BALANCE_PARAMETERS = 60_000;
const HOLDER_BALANCE_PARAMETERS_PER_ROW = 4;
const MAX_HOLDER_BALANCE_ROWS_PER_INSERT = Math.floor(
  MAX_HOLDER_BALANCE_PARAMETERS / HOLDER_BALANCE_PARAMETERS_PER_ROW,
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TOKEN_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** The ERC-20 `Transfer` event, the one log this indexer reads. */
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

// --- Recent-transfer buffer, for signal provenance -------------------------

/**
 * A capped ring of the most recent transfers per token, in Redis.
 *
 * `holder-concentration` cites the tx hashes of the material transfers behind a
 * concentration move. The indexer already decodes every `Transfer` log, so
 * capturing them here costs nothing; storing them in `holder_balances` would
 * not (that table is one row per address). Redis, trimmed and TTL'd, matches how
 * FLOW and PEG_DRIFT keep their own non-authoritative series off-schema.
 */
const RECENT_XFERS_KEY_PREFIX = "signals:holderconc:xfers:v1:";
const RECENT_XFERS_MAX = 500;
const RECENT_XFERS_TTL_SEC = 4 * 24 * 60 * 60;

export interface RecentTransfer {
  /** Block number. */
  b: number;
  /** Transaction hash. */
  h: string;
  /** From address, lowercased. */
  f: string;
  /** To address, lowercased. */
  t: string;
  /** Raw value, decimal string. */
  v: string;
}

function recentXfersKey(tokenAddress: string): string {
  return RECENT_XFERS_KEY_PREFIX + tokenAddress.toLowerCase();
}

async function recordRecentTransfers(
  tokenAddress: string,
  transfers: readonly RecentTransfer[],
): Promise<void> {
  if (transfers.length === 0) return;
  const key = recentXfersKey(tokenAddress);
  // Trim before the push: a busy chunk can carry thousands of transfers and
  // only the last RECENT_XFERS_MAX survive the ltrim anyway.
  const recent = transfers.slice(-RECENT_XFERS_MAX);
  try {
    await redis.rpush(key, ...recent.map((transfer) => JSON.stringify(transfer)));
    await redis.ltrim(key, -RECENT_XFERS_MAX, -1);
    await redis.expire(key, RECENT_XFERS_TTL_SEC);
  } catch (err) {
    // Provenance is advisory. A Redis hiccup must not stop the balance index.
    log.warn("transfer-indexer: could not record recent transfers for provenance", {
      tokenAddress,
      err,
    });
  }
}

/** The recent transfers held for one token, newest last. Best-effort: an empty
 *  list is normal on a cold cache and `holder-concentration` falls back to the
 *  block range alone. */
export async function loadRecentTransfers(tokenAddress: string): Promise<RecentTransfer[]> {
  try {
    const raw = await redis.lrange(recentXfersKey(tokenAddress), 0, -1);
    const out: RecentTransfer[] = [];
    for (const entry of raw) {
      try {
        const parsed = JSON.parse(entry) as RecentTransfer;
        if (typeof parsed.h === "string" && typeof parsed.v === "string") out.push(parsed);
      } catch {
        // A malformed entry is not worth failing the read over.
      }
    }
    return out;
  } catch (err) {
    log.warn("transfer-indexer: could not load recent transfers", { tokenAddress, err });
    return [];
  }
}

// --- The cycle ------------------------------------------------------------

export interface TransferIndexSummary {
  startedAt: string;
  durationMs: number;
  /** Stock Token addresses the indexer is watching. */
  tokens: number;
  /** True only on the run that persisted the starting head. */
  firstRun: boolean;
  startBlock: number;
  /** Cursor before this run. */
  fromBlock: number;
  /** Cursor after this run. */
  toBlock: number;
  /** Chain head this run observed. */
  head: number;
  /** Block chunks applied. */
  chunks: number;
  /** `Transfer` logs decoded. */
  transfers: number;
  /** (token, address) balance rows touched. */
  balanceRows: number;
  /** True when the cap stopped this run short of head. */
  cappedByMaxChunks: boolean;
  rpcRequests: number;
}

/**
 * Watched token set: every authentic Stock Token, address-validated.
 *
 * `authentic` rather than `signalEligible` on purpose. `signalEligible` also
 * requires a live price, so a REST outage that blanks it for a cycle would make
 * the indexer skip a token's transfers for that block range with no way to
 * recover them (the cursor is shared across tokens and only moves forward). An
 * address match is stable, so the watch set does not flap. `holder-concentration`
 * still emits only for the `signalEligible` subset.
 */
async function loadTokenAddresses(): Promise<Address[]> {
  const rows = await db
    .select({ tokenAddress: universe.tokenAddress })
    .from(universe)
    .where(eq(universe.authentic, true));

  const out: Address[] = [];
  for (const row of rows) {
    if (!TOKEN_ADDRESS.test(row.tokenAddress)) {
      log.warn("transfer-indexer: skipping malformed token address", {
        tokenAddress: row.tokenAddress,
      });
      continue;
    }
    out.push(getAddress(row.tokenAddress));
  }
  return out;
}

interface ChainTransfer {
  tokenAddress: string;
  from: string;
  to: string;
  value: bigint;
  blockNumber: number;
  txHash: string;
}

/** One `Transfer` log query. Split out so its `args` narrowing survives being
 *  named as the adaptive reader's return type. */
function fetchTransferLogs(
  addresses: readonly `0x${string}`[],
  fromBlock: number,
  toBlock: number,
) {
  return logsClient.getLogs({
    address: addresses as `0x${string}`[],
    event: TRANSFER_EVENT,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
    strict: true,
  });
}

type TransferLogs = Awaited<ReturnType<typeof fetchTransferLogs>>;

/**
 * `eth_getLogs` for one block span, against free-tier RPCs that fail in several
 * provider-specific ways.
 *
 * Measured against `rpc.mainnet.chain.robinhood.com` with the live 194-address
 * universe: the full list over 2,000 blocks answers `log query timed out`, the
 * same list over 500 answers in under two seconds, and any of it answers
 * `Too Many Requests` when the caller does not pace itself. Neither failure is
 * a function of the address count, so splitting the address list is the wrong
 * lever: it multiplies request count and buys more 429s.
 *
 * So: halve the span and retry on a timeout, body/range refusal or a provider
 * free-plan range message; back off and retry on a rate limit; and let anything
 * else propagate. A span that halves below one block cannot be narrowed further
 * and is a real failure.
 */
async function getLogsAdaptive(
  addresses: readonly `0x${string}`[],
  fromBlock: number,
  toBlock: number,
): Promise<TransferLogs> {
  const out: TransferLogs = [];
  const pending: [number, number][] = [[fromBlock, toBlock]];
  let rateLimitRetries = 0;

  while (pending.length > 0) {
    const [from, to] = pending.shift()!;
    try {
      const logs = await fetchTransferLogs(addresses, from, to);
      out.push(...logs);
      // Pace the next request. The 429s arrive in bursts when chunks are sent
      // back to back, and a wedged cursor costs far more than this delay.
      if (pending.length > 0) await sleep(RPC_PACING_MS);
    } catch (err) {
      // The name matters as much as the message: viem raises its own
      // ResponseBodyTooLargeError before the body is ever parsed, so the text
      // that identifies it is in the class name, not in an rpc error string.
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (/too many requests|429/i.test(message)) {
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) throw err;
        rateLimitRetries += 1;
        pending.unshift([from, to]);
        await sleep(RPC_PACING_MS * 4 * rateLimitRetries);
        continue;
      }
      // Four different refusals mean the same thing: this span is too wide.
      // All four were measured against live providers, and each one used to
      // throw straight out of the cycle and wedge the cursor again:
      //
      //   "log query timed out"                      slow range, server side
      //   "logs matched by query exceeds limit of 10000"  busy range, server side
      //   ResponseBodyTooLargeError                  viem's own 10MB body cap
      //   "Free tier ... up to a 10 block range"       provider plan boundary
      //
      // The body-size case never reaches the server's error path at all, which is why
      // matching on rpc error text alone was not enough.
      if (
        /timed out|timeout|exceeds? limit|too many results|ResponseBodyTooLarge|body exceeded|free (?:tier|plan).*?(?:eth_getlogs|getlogs|log)|(?:eth_getlogs|getlogs).*?(?:up to|range).*?(?:block|10)|(?:block )?range.*?(?:upgrade|should work)/i.test(
          message,
        )
      ) {
        if (to <= from) throw err;
        const mid = from + Math.floor((to - from) / 2);
        pending.unshift([from, mid], [mid + 1, to]);
        continue;
      }
      throw err;
    }
  }
  return out;
}

/** Fold a chunk's logs into per-(token, address) deltas. Aggregated in memory
 *  first so one `(token, address)` pair is never in the VALUES list twice, which
 *  Postgres rejects on an upsert. */
function foldDeltas(transfers: readonly ChainTransfer[]): Map<string, Map<string, bigint>> {
  const deltas = new Map<string, Map<string, bigint>>();
  const bump = (token: string, address: string, amount: bigint): void => {
    let inner = deltas.get(token);
    if (!inner) {
      inner = new Map();
      deltas.set(token, inner);
    }
    inner.set(address, (inner.get(address) ?? 0n) + amount);
  };
  for (const transfer of transfers) {
    bump(transfer.tokenAddress, transfer.from, -transfer.value);
    bump(transfer.tokenAddress, transfer.to, transfer.value);
  }
  return deltas;
}

/**
 * Applies one chunk's deltas and advances the cursor, atomically.
 *
 * The upsert adds the delta to the stored balance (`balance + EXCLUDED.balance`),
 * and the cursor bump rides in the same transaction. Either the whole chunk
 * lands or none of it does.
 */
async function applyChunk(
  deltas: Map<string, Map<string, bigint>>,
  chunkTo: number,
): Promise<number> {
  const now = new Date();
  const values: ReturnType<typeof sql>[] = [];
  for (const [token, inner] of deltas) {
    for (const [address, delta] of inner) {
      if (delta === 0n) continue;
      values.push(
        sql`(${token}, ${address}, ${delta.toString()}::numeric, ${now.toISOString()}::timestamptz)`,
      );
    }
  }

  await db.transaction(async (tx) => {
    for (let offset = 0; offset < values.length; offset += MAX_HOLDER_BALANCE_ROWS_PER_INSERT) {
      const batch = values.slice(offset, offset + MAX_HOLDER_BALANCE_ROWS_PER_INSERT);
      await tx.execute(sql`
        INSERT INTO holder_balances (token_address, address, balance, updated_at)
        VALUES ${sql.join(batch, sql`, `)}
        ON CONFLICT (token_address, address) DO UPDATE
          SET balance = holder_balances.balance + EXCLUDED.balance,
              updated_at = EXCLUDED.updated_at
      `);
    }
    await tx
      .update(indexerState)
      .set({ lastBlock: chunkTo, updatedAt: now })
      .where(eq(indexerState.indexer, TRANSFER_INDEXER));
  });

  return values.length;
}

/**
 * One index cycle. Returns a summary; throws only on a genuine defect (an RPC or
 * DB failure), never for "caught up, nothing to do".
 */
export async function indexTransfers(now = new Date()): Promise<TransferIndexSummary> {
  const startedMs = Date.now();
  const summary: TransferIndexSummary = {
    startedAt: now.toISOString(),
    durationMs: 0,
    tokens: 0,
    firstRun: false,
    startBlock: 0,
    fromBlock: 0,
    toBlock: 0,
    head: 0,
    chunks: 0,
    transfers: 0,
    balanceRows: 0,
    cappedByMaxChunks: false,
    rpcRequests: 0,
  };

  const tokenAddresses = await loadTokenAddresses();
  summary.tokens = tokenAddresses.length;
  if (tokenAddresses.length === 0) {
    // Nothing to watch until BE-5 has produced a signal-eligible row. Not an
    // error: on a cold deploy the refresher wins the race eventually.
    log.warn("transfer-indexer: no signal-eligible tokens, nothing to index");
    summary.durationMs = Date.now() - startedMs;
    return summary;
  }

  const existing = await db
    .select()
    .from(indexerState)
    .where(eq(indexerState.indexer, TRANSFER_INDEXER));
  let state = existing[0];

  const chain = await countRpcRequests(
    async () => {
      const head = Number(await publicClient.getBlockNumber());

      if (!state) {
        // First run: record the head and index forward from here. No historical
        // scan (locked decision 9). `startBlock` is the head minus confirmations
        // so the first real chunk does not immediately reach into an unconfirmed
        // range.
        const startBlock = Math.max(0, head - CONFIRMATIONS);
        await db.insert(indexerState).values({
          indexer: TRANSFER_INDEXER,
          startBlock,
          lastBlock: startBlock,
          startedAt: now,
          updatedAt: now,
        });
        state = {
          indexer: TRANSFER_INDEXER,
          startBlock,
          lastBlock: startBlock,
          startedAt: now,
          updatedAt: now,
        };
        summary.firstRun = true;
        return { head, transfers: 0, balanceRows: 0, chunks: 0, capped: false };
      }

      const target = Math.max(0, head - CONFIRMATIONS);
      let cursor = state.lastBlock + 1;
      let chunks = 0;
      let totalTransfers = 0;
      let totalBalanceRows = 0;

      while (cursor <= target && chunks < MAX_CHUNKS_PER_RUN) {
        const chunkTo = Math.min(cursor + CHUNK_BLOCKS - 1, target);

        const logs = await getLogsAdaptive(tokenAddresses, cursor, chunkTo);

        const transfers: ChainTransfer[] = [];
        for (const entry of logs) {
          if (entry.blockNumber === null || entry.transactionHash === null) continue;
          transfers.push({
            tokenAddress: entry.address.toLowerCase(),
            from: entry.args.from.toLowerCase(),
            to: entry.args.to.toLowerCase(),
            value: entry.args.value,
            blockNumber: Number(entry.blockNumber),
            txHash: entry.transactionHash,
          });
        }

        const balanceRows = await applyChunk(foldDeltas(transfers), chunkTo);
        totalTransfers += transfers.length;
        totalBalanceRows += balanceRows;

        // Provenance buffer, per token, after the chunk is durably committed.
        const byToken = new Map<string, RecentTransfer[]>();
        for (const transfer of transfers) {
          const list = byToken.get(transfer.tokenAddress) ?? [];
          list.push({
            b: transfer.blockNumber,
            h: transfer.txHash,
            f: transfer.from,
            t: transfer.to,
            v: transfer.value.toString(),
          });
          byToken.set(transfer.tokenAddress, list);
        }
        for (const [token, list] of byToken) await recordRecentTransfers(token, list);

        cursor = chunkTo + 1;
        chunks += 1;
      }

      return {
        head,
        transfers: totalTransfers,
        balanceRows: totalBalanceRows,
        chunks,
        capped: cursor <= target,
      };
    },
    { operation: "research-transfer-index", context: "research", priority: "recovery" },
  );

  summary.rpcRequests = chain.requests;
  summary.head = chain.value.head;
  summary.startBlock = state!.startBlock;
  summary.fromBlock = summary.firstRun ? state!.startBlock : state!.lastBlock + 1;
  summary.transfers = chain.value.transfers;
  summary.balanceRows = chain.value.balanceRows;
  summary.chunks = chain.value.chunks;
  summary.cappedByMaxChunks = chain.value.capped;

  const after = await db
    .select({ lastBlock: indexerState.lastBlock })
    .from(indexerState)
    .where(eq(indexerState.indexer, TRANSFER_INDEXER));
  summary.toBlock = after[0]?.lastBlock ?? summary.startBlock;
  summary.durationMs = Date.now() - startedMs;

  log.info("transfers indexed", { ...summary });
  return summary;
}
