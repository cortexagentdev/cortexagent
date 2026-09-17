# Cortex API

Backend and smart contracts for researching tokenized equities and interacting with shared thematic vaults on Robinhood Chain.

The API serves asset data, signals, thematic baskets, portfolio reads, and unsigned transaction plans. Background workers ingest market and chain data, compute signals, evaluate alerts, and index vault activity. Users sign and submit transactions with their own wallets; the API and workers do not hold deployment or user signing keys.

## Stack

- **API:** Bun, TypeScript, Hono, tRPC v11, Zod, SuperJSON, viem.
- **Storage and jobs:** PostgreSQL 16 with TimescaleDB, Drizzle ORM, Redis 7, BullMQ.
- **Contracts:** Solidity 0.8.28, Foundry 1.8.1, OpenZeppelin.

## Repository structure

```text
api/
  src/
    routers/       tRPC procedures and input validation
    auth/          Wallet sessions
    chain/         RPC clients, contract ABIs, and chain reads
    execution/     Deployment verification, routes, quotes, transaction plans
    workers/       Ingestion, signals, alerts, and chain indexers
    queue/         BullMQ jobs and schedules
    db/            Database schema, client, and migration runner
    signals/       Signal computation
    universe/      Asset eligibility and price data
    lenses/        Thematic basket definitions and loading
    ops/           Operational health
    index.ts       HTTP server
    worker.ts      Background worker entry point
  drizzle/         SQL migrations
  data/            Asset classifications, lenses, venues, and calendars
  .env.example     Local API configuration
shared/            Shared contract types and transaction helpers
contracts/
  src/             Solidity contracts
  test/            Unit, invariant, and fork tests
  script/          Foundry deployment scripts
  deployments/     Network manifests, addresses, receipts, verification records
  lib/             Contract dependencies and their licenses
  foundry.toml     Compiler and build settings
config/            Mainnet configuration and manifest templates
Dockerfile.api     API, worker, and migration image
docker-compose.dev.yml  Local PostgreSQL and Redis
```

## Local setup

Install Bun 1.x and Docker with Compose v2. Contract development also requires Foundry 1.8.1. Contract dependencies are included under `contracts/lib/` in the public source snapshot.

From the repository root:

```sh
docker compose -f docker-compose.dev.yml up -d --wait
cd api
bun install --frozen-lockfile
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `JWT_SECRET` in `api/.env`. The example uses PostgreSQL at `127.0.0.1:5433` and Redis at `127.0.0.1:6380`. Set `WEB_ORIGIN` to the exact client origin used for wallet sign-in.

Then start the API:

```sh
# In api/
bun run db:migrate
bun run dev
```

Start the worker in a second terminal:

```sh
cd api
bun run worker
```

The API listens on port **3001** by default. The worker populates research data; a fresh database will initially have limited results.

```sh
curl http://localhost:3001/health
curl http://localhost:3001/ops/health
curl http://localhost:3001/trpc/stats.overview
```

## Configuration

Environment variables are validated at startup. See [api/.env.example](api/.env.example) and [api/src/env.ts](api/src/env.ts) for the complete configuration.

| Variable                                        | Purpose                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                  | PostgreSQL connection; TimescaleDB is required.                                      |
| `REDIS_URL`                                     | Cache, rate limits, and job queues.                                                  |
| `RHJ_BASE_URL`                                  | Robinhood REST data source; supplied in the example.                                 |
| `JWT_SECRET`                                    | Secret for signed wallet sessions.                                                   |
| `WEB_ORIGIN`                                    | Allowed client origin and SIWE domain/URI validation.                                |
| `RHC_RPC_URL`                                   | Mainnet research RPC; chain ID defaults to `4663`.                                   |
| `RHC_RPC_URLS`, `RHC_LOGS_RPC_URLS`             | Optional ordered RPC endpoints for reads and log indexing.                           |
| `PORT`                                          | HTTP port; defaults to `3001`.                                                       |
| `EXECUTION_MODE`                                | Unset for research only; `robinhood-mainnet` enables mainnet execution verification. |
| `EXECUTION_MANIFEST_PATH`                       | Path to the receipt-verified execution manifest.                                     |
| `EXECUTION_DEPLOYMENT_ID`                       | Deployment identity matching the manifest.                                           |
| `EXECUTION_RPC_URLS`, `EXECUTION_LOGS_RPC_URLS` | Execution RPC endpoints, configured separately from research.                        |
| `EXECUTION_WALLET_RPC_URL`                      | Public RPC URL returned to wallet clients; must not contain provider keys.           |

To use the deployed mainnet vaults, configure execution using [config/mainnet.env.example](config/mainnet.env.example), the manifest at `contracts/deployments/4663.json`, and deployment ID `mainnet-4663-preset-v6-zero-fee-v1`. Adjust container paths for host execution. API and worker startup verify the deployment, bind the database to its identity, and restore registered preset records. Use a separate database for a local fork.

## API

The typed API is mounted at **`/trpc`**. [AppRouter](api/src/routers/index.ts) exports its TypeScript contract; procedure inputs are defined in [api/src/routers/](api/src/routers/). Use a tRPC v11 client with SuperJSON for serialization.

| Router               | Purpose                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `universe`           | Asset list, eligibility, and asset details.                                       |
| `signal`             | Signal feed and individual signals.                                               |
| `lens`               | Thematic baskets and their underlying research.                                   |
| `stats`              | Aggregate research statistics.                                                    |
| `auth`               | SIWE nonce, signature verification, session, and logout.                          |
| `watchlist`, `alert` | Wallet-owned watchlists and alert rules; authentication required.                 |
| `theme`              | Basket construction, previews, registered shared vaults, and execution readiness. |
| `vault`              | Vault reads, quotes, unsigned deposit/withdrawal plans, and deferred claims.      |
| `fee`                | Recorded creator-fee accounting.                                                  |

Research reads are public. Protected procedures require a wallet session: call `auth.nonce`, sign an EIP-4361 message, then call `auth.verify`. The server issues an HttpOnly `cortex_session` cookie valid for 24 hours; nonces expire after 5 minutes. Browser clients must include credentials and use the configured origin.

Vault transaction planning requires authentication and verified execution readiness. Public vault creation is disabled: `theme.save`, `theme.deploy`, and `theme.recordBroadcast` reject requests.

Requests under `/trpc/*` use a Redis-backed per-IP token bucket: burst capacity 120, refill 20 requests/second. Exceeding it returns HTTP 429 with `Retry-After: 1`.

Operational HTTP endpoints:

| Endpoint                   | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `GET /health`              | Research RPC reachability and chain head.        |
| `GET /ops/health`          | Operational health and degraded-state reporting. |
| `GET /execution/discovery` | Execution registry and discovery status.         |
| `GET /execution/indexer`   | Vault indexer progress and reorg status.         |
| `GET /admin/unclassified`  | Assets missing a classification.                 |

Execution status endpoints return 503 when execution is unconfigured or unavailable. These operational routes have no session guard; restrict access at the reverse proxy when needed.

## Contracts

The current release is **`preset-v6-zero-fee-v1`**.

- `PresetThemeFactory` creates one vault per fixed preset through an immutable designated deployer. It cannot add or replace presets.
- `ThemeToken` represents transferable ownership of a vault's active backing.
- `KeylessVault` supports in-kind and routed USDG deposits and withdrawals. Failed withdrawal legs become claims owned by the withdrawing wallet and can be retried with `claimDeferred`.
- `UniswapV3SwapRouter02Adapter` handles user-requested routed swaps.
- `VaultDeployer` is the factory's statically linked deployment library.
- `FeeController` records accounting. Current presets have zero creator fees and no fee payout.

Vaults are immutable and do not automatically rebalance. Deferred claims do not transfer with remaining shares. Legacy factory contracts remain in the source for compatibility.

### Mainnet addresses

**Robinhood Chain · chain ID 4663 · deployed September 15, 2026.**

Addresses below come from the committed [deployment manifest](contracts/deployments/4663.json). [Deployment records](contracts/deployments/4663.md) include explorer links and transaction hashes.

| Contract                     | Address                                      |
| ---------------------------- | -------------------------------------------- |
| PresetThemeFactory           | `0xDA01ee6AF692cf53B8Ec662a95C389bFb64ccb2C` |
| VaultDeployer                | `0x1E3A7d310FA0686BF804cF5bA5086b35E8113921` |
| UniswapV3SwapRouter02Adapter | `0xF9a1297b28116b0C241a0F55ED6ED79514aeF349` |

| Preset                 | Contract      | Address                                      |
| ---------------------- | ------------- | -------------------------------------------- |
| AI infrastructure      | ThemeToken    | `0x1892292CC6E492833BB45721E0996EF0423B8D7a` |
| AI infrastructure      | KeylessVault  | `0x527F86FC8F0d0f5f664960Cc7f17d25D8f3EEF50` |
| AI infrastructure      | FeeController | `0xB1940d1E1F03Ec07329676B64CA8C14e349ED28E` |
| Data centers and power | ThemeToken    | `0x951d33246B78C73031503FFf2d5744776A94317C` |
| Data centers and power | KeylessVault  | `0x92178a8072Fd38c7290eD7f6675Ae2d5AfFFcc25` |
| Data centers and power | FeeController | `0xeB1d42d2973D7828D34b4886eEc9e9Ec56CaFd78` |
| Defense                | ThemeToken    | `0x972DcB97e70855D0eb280032b3eBd07742925C66` |
| Defense                | KeylessVault  | `0x23232C10949203486a4ae2E9e1d04C828e292b82` |
| Defense                | FeeController | `0xB48f0fD0424Fc2E7448C8825E9648F7056358a5E` |
| Rate-cut beneficiaries | ThemeToken    | `0xcA013B24f02013a7D348F2b3ae22B5f0B45394aE` |
| Rate-cut beneficiaries | KeylessVault  | `0x9F3F00A13026fD0b9494a673aBfaD9bE176FD00E` |
| Rate-cut beneficiaries | FeeController | `0x4D008b204118130D18D5dCE9Aa48F17c25D5fF8a` |

The external settlement token is **USDG** (6 decimals): `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. The testnet record (`46630`) contains no deployed addresses.

### Build and checks

```sh
# From api/
bun run typecheck
bun run lint
bun run build

# From the repository root, with Foundry 1.8.1
forge build --root contracts
forge test --root contracts --no-match-contract '.*Fork.*'
forge fmt --root contracts --check
```

The contract configuration pins Solidity **0.8.28**, Shanghai, optimizer runs **200**, and via-IR, with bytecode metadata disabled. Run network-dependent fork tests separately with the required RPC access.

For database schema changes, edit `api/src/db/schema.ts`, run `bun run db:generate` from `api/`, and commit the generated migration. Apply it with `bun run db:migrate`.

## Deployment and operations

Build the backend image from the repository root:

```sh
docker build -f Dockerfile.api -t cortex-api .
```

The same image runs the API (`bun api/src/index.ts`), worker (`bun api/src/worker.ts`), or one-shot migrator (`bun api/src/db/migrate.ts`). Supply runtime environment variables and mount the execution manifest read-only at `EXECUTION_MANIFEST_PATH`; the image does not include contract deployment files.

Run PostgreSQL and Redis on a private network with persistent storage. Back up the database, run migrations once before starting API and worker processes, and serve the API behind HTTPS. Configure the proxy to replace client IP headers used for rate limiting. Monitor `/ops/health`, execution indexer lag, and both process logs.

## Security and license

No independent security audit is recorded. Deployment receipt/runtime verification is separate from explorer source verification; the timestamped [verification record](contracts/deployments/4663.verification.json) tracks the latter. Issuer restrictions, oracle failures, and insufficient liquidity can prevent routed actions or delay withdrawals.

Keep session secrets, provider credentials, and signing keys out of source control. Deploy contracts only from separate operator tooling with a hardware wallet or encrypted keystore.

No project-wide license is currently included. Dependency licenses remain under `contracts/lib/`; they do not license the rest of this repository.
