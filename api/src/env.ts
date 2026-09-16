import { z } from "zod";

const rpcRateList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .transform((values) => values.map(Number))
  .pipe(z.array(z.number().positive().max(1_000)))
  .optional();

/**
 * Env is parsed at import time and throws on anything missing or malformed.
 * A container that boots with half its config is worse than one that refuses to start.
 */
const envSchema = z.object({
  // Postgres + TimescaleDB.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Redis, used for the cache and for BullMQ.
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // Robinhood Chain mainnet. Every data read targets this chain (locked decision 6).
  //
  // The public RPC host is `rpc.mainnet.chain.robinhood.com`, verified by
  // eth_chainId returning 0x1237 (4663) and published at
  // https://docs.robinhood.com/chain/connecting. It is NOT `rpc.robinhood.com`,
  // which is what CortexImplementationPlan.md carried: that host exists, serves
  // a certificate and then refuses the TLS handshake, so it fails as a
  // connection error rather than as a 404 and reads like a network problem on
  // the caller's side. Alchemy serves the same chain behind an API key; the
  // public endpoint keeps C1 inside locked decision 7 (free-tier data only).
  RHC_RPC_URL: z.url().default("https://rpc.mainnet.chain.robinhood.com"),
  /**
   * Mainnet endpoints, comma separated. Rotate the first RHC_RPC_ROTATION_SIZE
   * entries for stateless reads; the rest are ordered fallbacks. Falls back to
   * the single `RHC_RPC_URL` when unset.
   *
   * These serve the general read path: `eth_call` through Multicall3,
   * `eth_getBlockByNumber`, `eth_chainId`. A keyed Alchemy endpoint answers
   * those in 40-60ms against roughly a second on the public host, and does not
   * rate limit at C1's polling volume, so it belongs at the front of this list.
   *
   * Log queries are NOT served from here. See `RHC_LOGS_RPC_URLS`.
   */
  RHC_RPC_URLS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.url()))
    .optional(),
  // 1 preserves ordered fallback. Set 2 with two independently budgeted keys
  // at the front of RHC_RPC_URLS. This does not affect the log endpoint list.
  RHC_RPC_ROTATION_SIZE: z.coerce.number().int().positive().max(16).default(1),
  /**
   * Per-endpoint request rates for `RHC_RPC_URLS`, in the same order. An
   * omitted or shorter list uses `RPC_DEFAULT_RPS` for the remaining entries.
   * Same-host keys share the lowest configured rate, not the sum. This is a
   * conservative per-process pacing guard, not an account quota claim.
   */
  RHC_RPC_RATE_LIMITS_RPS: rpcRateList,
  /**
   * Endpoints for `eth_getLogs` only, best first. A recommended free setup is
   * Validation Cloud, public Robinhood, then Alchemy; the operator must verify
   * each account's current range and quota before relying on it.
   *
   * Deliberately separate, because the ranking inverts for this one method.
   * Measured against the live 194-address Transfer filter:
   *
   *   public RHC   500 blocks, 3,138 logs, 966ms          works
   *   Alchemy free ANY range over 10 blocks               refused outright
   *
   * "Under the Free tier plan, you can make eth_getLogs requests with up to a
   * 10 block range." Alchemy is therefore a bounded fallback here, not the
   * primary historical indexer endpoint. The list is ordered explicitly and
   * the transport rate-limits each host independently.
   */
  RHC_LOGS_RPC_URLS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.url()))
    .optional(),
  /** Per-endpoint `eth_getLogs` rates for `RHC_LOGS_RPC_URLS`, same order. */
  RHC_LOGS_RPC_RATE_LIMITS_RPS: rpcRateList,
  RHC_CHAIN_ID: z.coerce.number().int().positive().default(4663),
  // RPC operations: low retries with viem's exponential delay, a hard HTTP
  // timeout, and a shared per-process cap. Interactive wallet reads reserve
  // capacity ahead of background discovery/indexing work.
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(15_000),
  RPC_RETRY_COUNT: z.coerce.number().int().nonnegative().max(3).default(2),
  // Log queries are larger and more heavily metered than ordinary reads. One
  // transport retry is enough because the ordered fallback list supplies the
  // next provider; repeated retries against the same free endpoint amplify a
  // rate-limit incident.
  RPC_LOGS_RETRY_COUNT: z.coerce.number().int().nonnegative().max(2).default(1),
  RPC_RETRY_DELAY_MS: z.coerce.number().int().positive().max(5_000).default(250),
  // Strict per-endpoint pacing. The ordered lists above can override these
  // values independently for every configured provider.
  RPC_DEFAULT_RPS: z.coerce.number().positive().max(1_000).default(4),
  RPC_LOGS_DEFAULT_RPS: z.coerce.number().positive().max(100).default(0.5),
  RPC_CONCURRENCY_CAP: z.coerce.number().int().positive().max(64).default(8),
  RPC_INTERACTIVE_RESERVED: z.coerce.number().int().nonnegative().max(32).default(2),
  RPC_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().max(20).default(3),
  RPC_CIRCUIT_OPEN_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
  RPC_STALLED_HEAD_MS: z.coerce.number().int().positive().max(3_600_000).default(180_000),
  RPC_METRICS_TTL_SEC: z.coerce.number().int().positive().max(86_400).default(900),
  RPC_LOG_PROBE_MAX_BLOCKS: z.coerce.number().int().positive().max(10_000).default(500),
  // Robinhood Chain testnet (46630). Vault writes only, C2 (locked decision 5).
  // eth_chainId returns 0xb626 (46630) here.
  RHC_TESTNET_RPC_URL: z.url().default("https://rpc.testnet.chain.robinhood.com"),
  // Public, browser-reachable URL only. Never expose the server's keyed RPC.
  RHC_TESTNET_WALLET_RPC_URL: z.url().default("https://rpc.testnet.chain.robinhood.com"),

  // Execution is intentionally separate from research. These fields have no
  // defaults: an installation that only indexes the mainnet universe must not
  // accidentally construct transactions against a public testnet endpoint.
  EXECUTION_MODE: z.enum(["local-fork", "robinhood-testnet", "robinhood-mainnet"]).optional(),
  EXECUTION_RPC_URLS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1))
    .optional(),
  // Independent of research. Keep 1 for local Anvil; mainnet can opt into a
  // read pool only after all its execution endpoints pass identity checks.
  EXECUTION_RPC_ROTATION_SIZE: z.coerce.number().int().positive().max(16).default(1),
  EXECUTION_LOGS_RPC_URLS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1))
    .optional(),
  EXECUTION_WALLET_RPC_URL: z.url().optional(),
  EXECUTION_MANIFEST_PATH: z.string().min(1).optional(),
  EXECUTION_DEPLOYMENT_ID: z.string().min(1).max(160).optional(),
  // Bounded execution discovery. Targeted reconciliation is the low-cost
  // baseline; state sampling is independent so a slow reconciliation cannot
  // make an otherwise healthy pool look stale.
  EXECUTION_DISCOVERY_INTERVAL_MS: z.coerce.number().int().min(60_000).default(600_000),
  EXECUTION_POOL_STATE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  EXECUTION_DISCOVERY_MAX_CANDIDATES: z.coerce.number().int().positive().max(100).default(24),

  // Robinhood free REST base, no auth, 60 rps (locked decision 7).
  RHJ_BASE_URL: z.url(),

  // Session signing for the SIWE JWTs issued by BE-21.
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),

  // The origin users actually browse. Two jobs, and the second one matters in
  // production:
  //
  //  1. Credentialed CORS allowlist in every environment. The production web
  //     and API may use different origins under the same HTTPS site.
  //  2. The domain SIWE binds every sign-in message to. `lib/siwe.ts` derives
  //     `expectedDomain()` from this host and `authRouter.verify` rejects any
  //     message naming a different one, so a signature captured for another
  //     site cannot be replayed here.
  //
  // Because of (2) this is NOT dev-only, and a wrong value fails closed: every
  // sign-in returns "Sign-in message failed validation" while the terminal
  // itself works perfectly, which reads like a wallet problem rather than a
  // configuration one. It must equal the origin in the browser's address bar,
  // scheme and port included: https://cortex.example.com in production,
  // http://127.0.0.1:8090 against the local compose stack.
  //
  // The Lovable vite-tanstack config binds the dev server to :8080, so that is
  // the dev default. Override for any other origin.
  WEB_ORIGIN: z.url().default("http://localhost:8080"),

  // Jobs the worker runs at once. One VPS shares its cores with Postgres and the
  // web app, so this is deliberately low.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_BACKLOG_CAP: z.coerce.number().int().positive().max(10_000).default(100),

  // --- Universe gate (BE-5) --------------------------------------------------
  // How far the Chainlink answer may sit from the independent /rhj/prices
  // midpoint before the feed is treated as disagreeing. Must stay above the
  // feed's own 0.5% deviation threshold, or a healthy feed drifting inside its
  // own band reads as divergent. This is the freshness test; feed age is not.
  UNIVERSE_FEED_TOLERANCE_PCT: z.coerce.number().positive().default(1),

  // Gate 2 floor, in USD of sampled pool depth. Zero by default because
  // api/data/pools.json ships empty: with no venue registry for RHC on the free
  // tier, a non-zero floor would exclude every asset for a gap in Cortex's own
  // data. Populate the registry and raise this together.
  UNIVERSE_DEPTH_FLOOR_USD: z.coerce.number().nonnegative().default(0),

  // Gate 3 floor: the smallest simulated redeem worth calling redeemable.
  UNIVERSE_MIN_REDEEM_USD: z.coerce.number().nonnegative().default(0),

  // --- Signals: FLOW processor (BE-11) -------------------------------------
  // |zScore| of the window's net issuance figure against the 30-day trailing
  // baseline at or above which a FLOW signal fires. Default 3 lines up with the
  // rank curve's half-power point (`signals/rank.ts` Z_HALF).
  SIGNAL_FLOW_Z_THRESHOLD: z.coerce.number().positive().default(3),
  // The window FLOW attributes the observed mint/burn figure to, as an ISO-8601
  // duration (PT<n>H and/or PT<n>M). The signal computer's shared window is
  // PT4H; this is a separate knob so FLOW can be retuned without moving every
  // other processor. Anchored to the same aligned window end, so the
  // deterministic signal id is unaffected.
  SIGNAL_FLOW_WINDOW_ISO: z
    .string()
    .regex(/^PT(?:\d+H)?(?:\d+M)?$/, "expected an ISO-8601 duration like PT4H")
    .default("PT4H"),

  // --- Signals: PEG_DRIFT processor (BE-12) -------------------------------
  // How far the on-chain DEX price may sit from the Chainlink reference before
  // the pair counts as diverging. Kept above the feed's own 0.5% deviation
  // threshold for the same reason UNIVERSE_FEED_TOLERANCE_PCT is: a healthy
  // feed drifting inside its own band must not read as a peg break. Also used
  // as the pairwise tolerance for the DEX/Chainlink/quote agreement check.
  SIGNAL_PEG_DRIFT_TOLERANCE_PCT: z.coerce.number().positive().default(1),
  // |zScore| of the DEX-to-Chainlink divergence against the 30-day trailing
  // baseline at or above which a PEG_DRIFT signal fires. Both the tolerance and
  // the z gate must trip.
  SIGNAL_PEG_DRIFT_Z_THRESHOLD: z.coerce.number().positive().default(3),
  // Sampled pool depth, in USD, below which the DEX read is treated as thin and
  // the signal is capped at LOW confidence. Zero disables the check, matching
  // UNIVERSE_DEPTH_FLOOR_USD while api/data/pools.json ships empty.
  SIGNAL_PEG_DRIFT_MIN_DEPTH_USD: z.coerce.number().nonnegative().default(0),

  // --- Signals: CORPORATE_ACTION processor (BE-13) -----------------------
  // The window a CORPORATE_ACTION signal attributes its observation to, as an
  // ISO-8601 duration. Corporate actions are scheduled multi-day events, not
  // intraday moves (BE-13 scope), so the default is one day and the knob only
  // accepts day or hour spans, never minutes.
  SIGNAL_CORPORATE_ACTION_WINDOW_ISO: z
    .string()
    .regex(/^P(?:\d+D)?(?:T\d+H)?$/, "expected an ISO-8601 duration like P1D or P2DT12H")
    .default("P1D"),

  // --- Signals: AFTER_HOURS_DISLOCATION processor (BE-14) ----------------
  // Signed percentage move of the on-chain price over the window at or above
  // which an AFTER_HOURS_DISLOCATION signal fires, but only while the reference
  // equity market is not in its regular session. A move this size during RTH is
  // PEG_DRIFT's or LIQUIDITY_SHIFT's business, not this one's.
  SIGNAL_AFTER_HOURS_THRESHOLD_PCT: z.coerce.number().positive().default(2),
  // The window the move is measured over, as an ISO-8601 duration (PT<n>H and/or
  // PT<n>M). Anchored to the shared window end, so the deterministic signal id
  // is unaffected; only the reported span moves.
  SIGNAL_AFTER_HOURS_WINDOW_ISO: z
    .string()
    .regex(/^PT(?:\d+H)?(?:\d+M)?$/, "expected an ISO-8601 duration like PT2H")
    .default("PT2H"),
  // Sampled on-chain depth, in USD, below which the overnight book is treated as
  // thin and confidence is reduced. Zero still counts as thin (no venue was
  // sampled); a positive value that clears this floor is what lifts a signal to
  // MED.
  SIGNAL_AFTER_HOURS_MIN_DEPTH_USD: z.coerce.number().nonnegative().default(0),

  // --- Transfer indexer (BE-15) ------------------------------------------
  // Confirmations the forward-only Transfer indexer stays behind chain head, so
  // a shallow reorg is resolved before its logs are applied. Never a backfill
  // knob: the indexer starts at the head at first run and only moves forward
  // (locked decision 9).
  TRANSFER_INDEXER_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(5),
  // Block span per eth_getLogs request. 500, not the "few thousand" the task
  // suggested: the full universe address list over 2,000 blocks is exactly what
  // the free-tier RPC times out on. The indexer halves the span further when a
  // request still times out, so this is a starting point rather than a limit.
  TRANSFER_INDEXER_CHUNK_BLOCKS: z.coerce.number().int().positive().default(500),
  // Chunks applied in one cycle. A cap so a worker that was down for a long
  // stretch catches up over several cycles rather than in one unbounded run.
  TRANSFER_INDEXER_MAX_CHUNKS_PER_RUN: z.coerce.number().int().positive().default(10),
  // Pause between eth_getLogs requests. The free-tier RHC RPC answers "Too Many
  // Requests" when chunks are sent back to back, which is one of the two ways
  // this indexer used to wedge; the other is "log query timed out", handled by
  // halving the block span. Measured: the full 194-address universe answers in
  // under two seconds over 500 blocks and times out over 2,000.
  TRANSFER_INDEXER_RPC_PACING_MS: z.coerce.number().int().nonnegative().default(500),
  // Do not retry a rate-limited range indefinitely inside one cycle. The next
  // scheduled cycle resumes from the durable cursor after provider cooldown.
  TRANSFER_INDEXER_MAX_RATE_LIMIT_RETRIES: z.coerce.number().int().nonnegative().max(10).default(2),

  // --- Signals: HOLDER_CONCENTRATION processor (BE-15) -------------------
  // Absolute day-over-day change in top-N holder share, in percentage points,
  // at or above which a HOLDER_CONCENTRATION signal fires.
  SIGNAL_HOLDER_CONCENTRATION_MIN_DELTA_PP: z.coerce.number().positive().default(1),
  // N in "top-N holder share". PART 3's example is the top decile.
  SIGNAL_HOLDER_CONCENTRATION_TOP_N: z.coerce.number().int().positive().default(10),
  // Candidate addresses per token whose balanceOfUI() is read for the ranking.
  // The set is the largest indexed balances; a larger number is more accurate
  // and costs more chain reads.
  SIGNAL_HOLDER_CONCENTRATION_CANDIDATES: z.coerce.number().int().positive().default(50),

  // --- Signals: LIQUIDITY_SHIFT processor (BE-16) -----------------------
  // Signed USD change in sampled pool depth over the window at or above which a
  // LIQUIDITY_SHIFT change is treated as material. Unlike the thin-depth knobs
  // above this is a materiality threshold, not a health check: a change below it
  // is not suppressed, it is emitted at LOW confidence and logged for pattern
  // tracking (BE-16 scope section 7).
  SIGNAL_LIQUIDITY_SHIFT_MIN_DEPTH_USD: z.coerce.number().nonnegative().default(100_000),
  // |zScore| of the window depth change against the 30-day trailing baseline the
  // change must also clear to count as material. Both this and the USD threshold
  // must trip for a signal above LOW confidence.
  SIGNAL_LIQUIDITY_SHIFT_Z_THRESHOLD: z.coerce.number().positive().default(3),
  // The window the depth change is measured over, as an ISO-8601 duration
  // (PT<n>H and/or PT<n>M). Anchored to the shared window end, so the
  // deterministic signal id is unaffected; only the reported span moves.
  SIGNAL_LIQUIDITY_SHIFT_WINDOW_ISO: z
    .string()
    .regex(/^PT(?:\d+H)?(?:\d+M)?$/, "expected an ISO-8601 duration like PT4H")
    .default("PT4H"),

  // --- Vault indexing (BE-26) ---------------------------------------------
  // The `ThemeFactory` address on RHC testnet (46630). C2 ships one factory to
  // testnet (BE-25e) and its address is recorded after that deploy. No default:
  // an invented address would make the vault indexer and the NAV poller watch
  // nothing while looking like they are working. Both workers no-op until it is
  // set. Testnet only, always (locked decision 5).
  RHC_TESTNET_THEME_FACTORY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "expected a 20-byte hex address")
    .optional(),
  // Block the vault indexer begins from on its first run. Set this to the
  // factory's deploy block so the `ThemeDeployed` log is caught. The default of
  // 0 scans testnet from genesis, which is affordable on 46630 but takes several
  // capped catch-up cycles to reach head.
  VAULT_INDEXER_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
  // Confirmations the vault indexer stays behind testnet head, so a shallow
  // reorg is resolved before its logs are applied.
  VAULT_INDEXER_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(5),
  // Block span per eth_getLogs request. A few thousand, well clear of a
  // genesis-scale scan on mainnet-sized chains.
  VAULT_INDEXER_CHUNK_BLOCKS: z.coerce.number().int().positive().default(2_000),
  // Chunks applied in one cycle. A cap so a worker that was down for a long
  // stretch, or a cold start from genesis, catches up over several cycles
  // rather than one unbounded run.
  VAULT_INDEXER_MAX_CHUNKS_PER_RUN: z.coerce.number().int().positive().default(25),
  // Retained chunk-boundary hashes for bounded common-ancestor recovery. A
  // deeper reorg becomes explicit degraded status and requires operator replay.
  VAULT_INDEXER_CHECKPOINT_RETENTION: z.coerce.number().int().positive().max(10_000).default(128),

  // --- Theme construction (FE-5) ------------------------------------------
  // The two policy fields `ThemeFactory.deployTheme()` rejects as address(0) and
  // an empty array, and which cannot be derived from the C1 universe: that data
  // describes mainnet 4663, and a theme deploys to testnet 46630 (locked
  // decisions 5 and 6). Both are optional and have no default: an invented USDG
  // or venue would produce a permanently broken immutable vault, so
  // `themeRouter.deploy` refuses to encode a transaction until they are set and
  // names what is missing.
  //
  // The USDG (settlement) token on testnet 46630, for the routed mint / redeem
  // paths. In-kind redeem never touches it (Design Law 7).
  RHC_TESTNET_USDG: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "expected a 20-byte hex address")
    .optional(),
  // The swap venue allowlist on testnet 46630, comma separated. User-requested swaps
  // may route nowhere else, so an empty list is not a permissive default, it is
  // an unbuildable policy.
  RHC_TESTNET_SWAP_VENUES: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/, "expected a 20-byte hex address")))
    .optional(),

  // Stamped on every log line. The api and the worker run the same image, so
  // without this the two processes are indistinguishable in a shared log stream.
  SERVICE_NAME: z.string().min(1).default("cortex-api"),

  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    // Written to stderr rather than the logger: the logger must not be a
    // prerequisite for reporting that the process cannot start.
    process.stderr.write(`Invalid environment configuration:\n${problems}\n`);
    throw new Error("Invalid environment configuration");
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
