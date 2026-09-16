import { keccak256, toHex, type PublicClient } from "viem";

/**
 * The public vault summary is a display read, not an execution snapshot. This
 * cache is deliberately process-local: the API is a single-host deployment,
 * and a trusted display observation must never become a Redis/DB record that a
 * different process can serve without re-running readiness and canonical-row
 * checks.
 *
 * The router owns those checks. This module owns only the bounded, immutable
 * snapshot exchange after the checks have succeeded. In particular, it knows
 * nothing about callers, sessions, balances, quotes or transaction plans.
 */

export const VAULT_DISPLAY_TTL_MS = 10_000;
const MAX_ENTRIES = 128;
const MAX_PENDING = 128;
const MAX_SCOPES = 256;
const PENDING_TIMEOUT_MS = 30_000;

export interface VaultDisplayIdentity {
  manifestDigest: string;
  /** Opaque provider/client identity. Never a URL or credential. */
  providerIdentity: string;
  deploymentId: string;
  chainId: number;
  tokenAddress: string;
  vaultAddress: string;
}

const handBuiltClientIds = new WeakMap<object, string>();
let nextHandBuiltClientId = 0;

/**
 * Verified execution contexts provide an opaque provider identity. A test or
 * hand-built context may not, so keep each client unshared rather than falling
 * back to a common placeholder that could cross-contaminate providers.
 */
export function vaultDisplayProviderIdentity(client: PublicClient): string {
  if (client.uid) return `uid:${client.uid}`;
  const object = client as unknown as object;
  let identity = handBuiltClientIds.get(object);
  if (!identity) {
    nextHandBuiltClientId += 1;
    identity = `client:${nextHandBuiltClientId}`;
    handBuiltClientIds.set(object, identity);
  }
  return identity;
}

/**
 * Scope is the invalidation identity. The immutable spec is intentionally not
 * included: a corrected DB row for the same canonical vault must invalidate
 * every prior spec-keyed entry in that scope.
 */
export function vaultDisplayScope(identity: VaultDisplayIdentity): string {
  return JSON.stringify([
    "vault-display-v1",
    identity.manifestDigest,
    identity.providerIdentity,
    identity.deploymentId,
    identity.chainId,
    identity.tokenAddress.toLowerCase(),
    identity.vaultAddress.toLowerCase(),
  ]);
}

/**
 * Build the complete cache key from the verified execution identity and the
 * row's immutable deployment/spec evidence. Caller-supplied slugs/revisions
 * are not accepted here, and symbol-only identity is impossible.
 */
export function vaultDisplayKey(scope: string, immutableSpec: unknown): string {
  return `${scope}|spec:${keccak256(toHex(JSON.stringify(immutableSpec)))}`;
}

interface CacheEntry<T> {
  value: T;
  scope: string;
  scopeToken: symbol;
  observedBlock: bigint | null;
  /** The read start, used for both the observation and the non-sliding TTL. */
  startedAt: number;
  expiresAt: number;
}

interface PendingEntry<T> {
  token: symbol;
  key: string;
  scope: string;
  scopeToken: symbol;
  startedAt: number;
  /** Invalidation/eviction detaches the result from every original waiter. */
  detached: boolean;
  promise: Promise<T | null>;
}

interface ScopeState {
  token: symbol;
  watermark: bigint | undefined;
}

export interface VaultDisplayRead<T> {
  key: string;
  scope: string;
  /** Started once for a miss and passed to the loader as the observation start. */
  load: (startedAt: number) => Promise<T | null>;
  observedBlock: (value: T) => bigint | null;
  now?: () => number;
}

function clone<T>(value: T): T {
  // VaultState is a plain object containing arrays and primitive values. A
  // structured clone ensures one request cannot mutate another request's
  // cached arrays or the pending leader's result.
  return structuredClone(value);
}

function timerUnref(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
  maybeTimer.unref?.();
}

/** A timeout only detaches the registry entry; it cannot cancel an RPC. */
function withPendingTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Vault display read timed out")), PENDING_TIMEOUT_MS);
    timerUnref(timer);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Bounded display snapshot registry. It uses an explicit non-sliding TTL and
 * monotonic per-scope block watermarks. A pending result that belongs to an
 * invalidated generation can never install over newer work.
 */
export class VaultDisplayCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly pending = new Map<string, PendingEntry<unknown>>();
  private readonly scopes = new Map<string, ScopeState>();

  /** A local generation token for the final router publication guard. */
  generation(scope: string): symbol {
    return this.ensureScope(scope).token;
  }

  async read<T>(request: VaultDisplayRead<T>): Promise<T | null> {
    const now = request.now ?? Date.now;
    this.prune(now());

    const scopeState = this.ensureScope(request.scope);
    const watermark = scopeState.watermark;
    const entry = this.entries.get(request.key) as CacheEntry<T> | undefined;
    if (entry) {
      if (
        entry.expiresAt > now() &&
        entry.scope === request.scope &&
        entry.scopeToken === scopeState.token &&
        this.isAtLeastWatermark(entry.observedBlock, watermark)
      ) {
        // Touching the insertion order supports bounded LRU eviction without
        // touching startedAt or expiresAt, so a hit never extends freshness.
        this.entries.delete(request.key);
        this.entries.set(request.key, entry);
        return clone(entry.value);
      }
      this.entries.delete(request.key);
    }

    const existing = this.pending.get(request.key) as PendingEntry<T> | undefined;
    if (existing && existing.scope === request.scope && !existing.detached)
      return cloneOrNull(await existing.promise);
    if (existing) {
      existing.detached = true;
      this.pending.delete(request.key);
    }

    const startedAt = now();
    const token = Symbol("vault-display-read");
    const pending: PendingEntry<T> = {
      token,
      key: request.key,
      scope: request.scope,
      scopeToken: scopeState.token,
      startedAt,
      detached: false,
      promise: Promise.resolve(null),
    };
    this.evictPendingForCapacity();

    pending.promise = withPendingTimeout(
      Promise.resolve()
        .then(() => request.load(startedAt))
        .then((value) => {
          if (value === null) return null;
          const observedBlock = request.observedBlock(value);
          // A successful loader that cannot establish an observation block is
          // still useful to its current caller, but it is not a cacheable
          // display snapshot. Freshness is part of the value's contract.
          if (observedBlock === null) {
            const ownsSlot =
              this.pending.get(request.key)?.token === pending.token && !pending.detached;
            return ownsSlot ? clone(value) : null;
          }
          const currentScope = this.scopes.get(request.scope);
          const currentWatermark = currentScope?.watermark;
          if (!this.isAtLeastWatermark(observedBlock, currentWatermark)) return null;

          // A result that completes after its ten-second read-start window can
          // still be returned to this caller, but it is not installed as a
          // fresh cache entry. This keeps slow reads from acquiring a new TTL.
          const freshAtCompletion = now() - startedAt < VAULT_DISPLAY_TTL_MS;
          const ownsSlot =
            this.pending.get(request.key)?.token === pending.token &&
            !pending.detached &&
            currentScope?.token === pending.scopeToken;
          // A receipt/replacement can detach a pending operation while its
          // underlying RPC is still in flight. Its original waiters must not
          // receive even an apparently newer block from that old operation.
          if (!ownsSlot) return null;
          if (freshAtCompletion) {
            this.entries.set(request.key, {
              value: clone(value),
              scope: request.scope,
              scopeToken: pending.scopeToken,
              observedBlock,
              startedAt,
              expiresAt: startedAt + VAULT_DISPLAY_TTL_MS,
            });
            this.evictEntriesForCapacity();
          }
          return clone(value);
        }),
    ).finally(() => {
      // A superseded pending read must not clear the replacement's slot.
      if (this.pending.get(request.key) === pending) this.pending.delete(request.key);
    });
    this.pending.set(request.key, pending as PendingEntry<unknown>);
    return cloneOrNull(await pending.promise);
  }

  /**
   * Advance a scope's confirmed-block watermark and detach all matching
   * pending work. Equal or older receipt blocks are replays and are no-ops.
   */
  invalidate(scope: string, confirmedBlock: bigint): void {
    if (confirmedBlock < 0n) return;
    const scopeState = this.ensureScope(scope);
    const previous = scopeState.watermark;
    if (previous !== undefined && confirmedBlock <= previous) return;
    scopeState.watermark = confirmedBlock;
    const nextToken = Symbol("vault-display-generation");
    // Every new watermark advances the response generation, including a
    // historical receipt below a currently held snapshot. Preserved entries
    // are retagged to that generation; a response that already escaped the
    // cache can still pass the final guard only when its block is strictly
    // newer than the confirmed watermark.
    for (const [key, entry] of this.entries) {
      if (entry.scope !== scope) continue;
      if (entry.observedBlock === null || entry.observedBlock <= confirmedBlock) {
        this.entries.delete(key);
      } else {
        entry.scopeToken = nextToken;
      }
    }
    // Pending work began before confirmation. Every original waiter is
    // detached and must refuse its result, even if its eventual provider block
    // happens to be higher than the receipt.
    for (const [key, entry] of this.pending) {
      if (entry.scope !== scope) continue;
      entry.detached = true;
      this.pending.delete(key);
    }
    scopeState.token = nextToken;
    this.trimScopes();
  }

  /**
   * Final publication guard for a router response. A cache hit may have
   * resolved before a receipt arrives and then spend time joining fresh DB
   * metadata; the response must check the watermark again immediately before
   * it is assembled.
   */
  isCurrent(scope: string, observedBlock: bigint | null, token?: symbol): boolean {
    const scopeState = this.scopes.get(scope);
    if (scopeState === undefined || !this.isAtLeastWatermark(observedBlock, scopeState.watermark))
      return false;
    if (token === undefined || scopeState.token === token) return true;
    // A historical receipt may advance the generation while preserving a
    // snapshot that is demonstrably newer. Equal-height data remains
    // rejected because it could have been observed before the transaction's
    // intra-block state transition.
    return (
      observedBlock !== null &&
      scopeState.watermark !== undefined &&
      observedBlock > scopeState.watermark
    );
  }

  private isAtLeastWatermark(observedBlock: bigint | null, watermark?: bigint): boolean {
    return watermark === undefined || (observedBlock !== null && observedBlock >= watermark);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private evictEntriesForCapacity(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private evictPendingForCapacity(): void {
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.pending.get(oldest);
      if (entry) entry.detached = true;
      this.pending.delete(oldest);
    }
  }

  private ensureScope(scope: string): ScopeState {
    const existing = this.scopes.get(scope);
    if (existing) return existing;
    const state: ScopeState = { token: Symbol("vault-display-generation"), watermark: undefined };
    this.scopes.set(scope, state);
    this.trimScopes();
    return this.scopes.get(scope) ?? state;
  }

  private trimScopes(): void {
    while (this.scopes.size > MAX_SCOPES) {
      // Prefer an inactive scope. If every scope has live work, detach the
      // oldest scope before dropping its generation; otherwise its pending
      // result could outlive the bounded scope map and publish later.
      const oldestInactive = [...this.scopes.keys()].find((scope) => !this.hasActiveWork(scope));
      const scope = oldestInactive ?? this.scopes.keys().next().value;
      if (scope === undefined) break;
      if (oldestInactive === undefined) this.detachScope(scope);
      this.scopes.delete(scope);
    }
  }

  private hasActiveWork(scope: string): boolean {
    return (
      [...this.entries.values()].some((entry) => entry.scope === scope) ||
      [...this.pending.values()].some((entry) => entry.scope === scope)
    );
  }

  private detachScope(scope: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.scope === scope) this.entries.delete(key);
    }
    for (const [key, entry] of this.pending) {
      if (entry.scope !== scope) continue;
      entry.detached = true;
      this.pending.delete(key);
    }
  }
}

function cloneOrNull<T>(value: T | null): T | null {
  return value === null ? null : clone(value);
}

/** One cache instance per API process. It is intentionally not exported as a route. */
export const vaultDisplayCache = new VaultDisplayCache();
