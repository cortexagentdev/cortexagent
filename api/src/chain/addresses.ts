/**
 * Verified chain constants, RHC mainnet (4663).
 *
 * Reproduced from `spec/CortexBackend.md` PART 9. Every value there was read
 * from mainnet, not from documentation, so this table is a local copy of a
 * measurement. Do not invent or guess an address.
 *
 * | Contract                                 | Address                                      |
 * | ---------------------------------------- | -------------------------------------------- |
 * | StockFactory (proxy)                     | `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046` |
 * | StockFactory (impl)                      | `0xEe351E53BCe6AAF106428358838197C91e36EE0E` |
 * | AccessControlsRegistry (also the beacon) | `0xe10b6f6B275de231345c20D14Ab812db62151b00` |
 * | Stock implementation                     | `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` |
 * | Multicall3                               | `0xcA11bde05977b3631167028862bE2a173976CA11` |
 * | USDG                                     | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
 * | WETH                                     | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
 *
 * PART 10 gate 7: these drift as Robinhood lists new names. The addresses, the
 * 35/96 Chainlink feed coverage and the 203/96 factory counts must all be
 * re-verified before a mainnet deploy.
 */

import type { Address } from "viem";

/**
 * ERC1967Proxy. Gate 1 authority: an asset is authentic only when its address
 * matches `tokenAddress(uid)` here. Never match on symbol (global do-not 3).
 */
export const STOCK_FACTORY_ADDRESS: Address = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";

/** Implementation behind the factory proxy. Kept for verification, not called directly. */
export const STOCK_FACTORY_IMPL_ADDRESS: Address = "0xEe351E53BCe6AAF106428358838197C91e36EE0E";

/** AccessControlsRegistry. Also the beacon for every Stock Token. */
export const ACCESS_CONTROLS_REGISTRY_ADDRESS: Address =
  "0xe10b6f6B275de231345c20D14Ab812db62151b00";

/**
 * The single `Stock` implementation shared by every Stock Token. One beacon
 * upgrade moves all of them at once, which is why "keyless" is scoped to
 * Cortex's own contracts and never to the assets a vault holds.
 */
export const STOCK_IMPLEMENTATION_ADDRESS: Address = "0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2";

/** Canonical Multicall3, same address on both chains. Batch every poll through it. */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const USDG_ADDRESS: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

export const WETH_ADDRESS: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/** What `StockFactory.tokenAddress()` returns for an unknown uid. Fail-closed (PART 2). */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * Heartbeat (86400s) plus a 3600s grace period. A liveness bound only.
 * Off-chain the freshness test is agreement with independent quotes, never age:
 * the stalest feeds are the most liquid instruments (SGOV measured 14h stale on
 * 3.6M daily volume). See PART 9 and global do-not 1.
 */
export const MAX_STALENESS_SEC = 90_000;
