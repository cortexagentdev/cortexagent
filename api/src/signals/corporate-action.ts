/**
 * CORPORATE_ACTION — a multiplier change that is visible before it lands (BE-13).
 *
 * `spec/CortexBackend.md` PART 3, "Corporate-action signals": the point of this
 * kind is to be *early*. A corporate action that surprises a vault is a bad
 * outcome; one that is visible days ahead is a feature. Three inputs feed it:
 *
 * 1. **`multiplierMismatch`** — the on-chain `uiMultiplier()` disagrees with the
 *    registry `currentMultiplier` from `/rhj/assets`. Computed by BE-5 and
 *    mirrored onto `universe.multiplierMismatch`. A mismatch is a signal, not
 *    something to silence.
 *
 * 2. **The scheduled-change pair** — on-chain `newUIMultiplier()` and
 *    `effectiveAt()`, mirrored onto `universe.newUIMultiplier` /
 *    `universe.multiplierEffectiveAt`. When `newUIMultiplier != uiMultiplier` a
 *    change is scheduled and readable before it applies. This is the
 *    forward-looking case and the most valuable one.
 *
 * 3. **`/rhj/corporate-actions`** — typed actions with a `processDate`, a
 *    `status` (e.g. `..._IN_PROGRESS`) and, for dividends, a `rate`. Used to
 *    classify what a multiplier change *means* (split, dividend) rather than
 *    just reporting a number, and matched to the asset by **address**, never by
 *    symbol (global do-not 3).
 *
 * ## Where the reads come from
 *
 * The multiplier trio is read from the `universe` table, which BE-5's refresher
 * keeps current from the same `uiMultiplier()` / `newUIMultiplier()` /
 * `effectiveAt()` calls this processor would otherwise make. A scheduled change
 * is visible for days, so a refresher-cycle-old value is not a freshness
 * problem, and reading the column spends no RPC budget (locked decision 7).
 * The exact values still travel in `sources` so a reader can re-read the chain.
 *
 * Per PART 3, holder math around a corporate action must use `balanceOfUI()` /
 * `totalSupplyUI()` rather than re-deriving from a raw balance and the
 * multiplier. This processor does no holder math: it compares two multipliers
 * and never multiplies a balance by one, so there is nothing to re-derive.
 *
 * ## magnitude and zScore
 *
 * `magnitude` is the **multiplier ratio**: `newMultiplier / oldMultiplier`, so a
 * 1 to 4 split reads 4.0 and a dividend that does not move the multiplier reads
 * 1.0.
 *
 * A corporate action is a discrete scheduled event, not a draw from a
 * distribution, so there is no trailing baseline and a z-score in the
 * FLOW / PEG_DRIFT sense does not exist. `zScore` instead carries the **size of
 * the multiplier move** so the feed ranks a 4:1 split above a routine
 * adjustment: `ratio - 1` for a split (4.0 -> 3.0), `-(1/ratio - 1)` for a
 * reverse split, and 0.0 when the multiplier does not move. `evidence.baseline`
 * is fixed at 1.0 (the no-change ratio) and `evidence.sampleSize` is 0, which is
 * the honest statement that this kind has no statistical baseline.
 *
 * ## confidence
 *
 * - **HIGH** when the on-chain multiplier evidence and an in-progress
 *   `/rhj/corporate-actions` entry agree that an action is happening.
 * - **MED** when only one source has it: an on-chain change with no matching
 *   REST entry, or a REST entry with nothing yet visible on-chain.
 */

import { eq } from "drizzle-orm";

import { universe } from "../db/schema.ts";
import { env } from "../env.ts";
import {
  CORPORATE_ACTION_STATUS_IN_PROGRESS,
  CORPORATE_ACTION_TYPE_CASH_DIVIDEND,
  fetchCorporateActions,
  type RhjCorporateAction,
} from "../rhj/index.ts";
import { formatFixed18, parseFixed18 } from "../universe/gates.ts";
import { registerProcessor } from "./registry.ts";
import type {
  Confidence,
  ProcessorContext,
  SignalAsset,
  SignalCandidate,
  SignalProcessor,
  TimeWindow,
} from "./types.ts";

/** Cited in `sources`. */
const RHJ_CORPORATE_ACTIONS_ENDPOINT = "GET /rhj/corporate-actions";
const RHJ_ASSETS_ENDPOINT = "GET /rhj/assets";

/** The window a CORPORATE_ACTION signal labels its observation with. */
export const CORPORATE_ACTION_WINDOW_ISO = env.SIGNAL_CORPORATE_ACTION_WINDOW_ISO;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** WAD bigint to a trimmed decimal: `4e18` -> `"4"`, `1.5e18` -> `"1.5"`. */
function fmtMultiplier(wad: bigint): string {
  const fixed = formatFixed18(wad);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

function roundRatio(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * `YYYY-MM-DD (Weekday)` in UTC for a unix-seconds timestamp, falling back to a
 * `/rhj` `processDate` string (`YYYY-MM-DD`, no zone) and finally to a fixed
 * phrase. The weekday is derived in UTC to match the date string it annotates.
 */
function fmtEffectiveDate(effectiveAtSec: number | null, processDate: string | null): string {
  if (effectiveAtSec !== null && effectiveAtSec > 0) {
    const date = new Date(effectiveAtSec * 1000);
    const iso = date.toISOString().slice(0, 10);
    return `${iso} (${WEEKDAYS[date.getUTCDay()]})`;
  }
  if (processDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(processDate)) {
    const day = new Date(`${processDate}T00:00:00Z`);
    if (!Number.isNaN(day.getTime())) return `${processDate} (${WEEKDAYS[day.getUTCDay()]})`;
    return processDate;
  }
  return "an unspecified date";
}

/** `4.0` -> `"4:1 split"`, `0.25` -> `"1:4 reverse split"`, else null. */
function splitLabelFromRatio(ratio: number): string | null {
  if (ratio > 1 && Number.isInteger(ratio)) return `${ratio}:1 split`;
  const inverse = 1 / ratio;
  if (ratio < 1 && Number.isInteger(roundRatio(inverse))) {
    return `1:${Math.round(inverse)} reverse split`;
  }
  return null;
}

interface MultiplierRow {
  uiMultiplier: bigint | null;
  newUIMultiplier: bigint | null;
  effectiveAtSec: number | null;
  registryMultiplier: bigint | null;
  multiplierMismatch: boolean;
}

export interface CorporateActionInput {
  asset: SignalAsset;
  multipliers: MultiplierRow;
  /** `/rhj/corporate-actions` entries already matched to this asset by address.
   *  Any status; the evaluator picks the relevant one. */
  actions: readonly RhjCorporateAction[];
  window: TimeWindow;
  /** The window end, used as the reference point for "before it lands". */
  now: Date;
}

/**
 * Pure evaluation: the multiplier trio plus the matched REST actions in, one
 * candidate or null out. No IO, so a fixture drives it directly.
 */
export function evaluateCorporateAction(input: CorporateActionInput): SignalCandidate | null {
  const { asset, multipliers, actions, window, now } = input;
  const { uiMultiplier, newUIMultiplier, effectiveAtSec, registryMultiplier, multiplierMismatch } =
    multipliers;

  const pendingActions = actions.filter(
    (action) => action.status === CORPORATE_ACTION_STATUS_IN_PROGRESS,
  );
  const classifyingAction = pendingActions[0] ?? actions[0] ?? null;

  const scheduled =
    uiMultiplier !== null &&
    newUIMultiplier !== null &&
    uiMultiplier > 0n &&
    newUIMultiplier > 0n &&
    newUIMultiplier !== uiMultiplier;

  const mismatch =
    multiplierMismatch &&
    uiMultiplier !== null &&
    registryMultiplier !== null &&
    uiMultiplier > 0n &&
    registryMultiplier > 0n &&
    uiMultiplier !== registryMultiplier;

  // Nothing on-chain and no in-progress action: there is nothing to be early
  // about.
  if (!scheduled && !mismatch && pendingActions.length === 0) return null;

  // Pick the narrative. The scheduled on-chain change is the strongest because
  // it names the exact new number and date; the registry mismatch is next; a
  // REST-only in-progress action is last and carries no multiplier move of its
  // own.
  let current: bigint;
  let target: bigint;
  let forwardLooking: boolean;

  if (scheduled) {
    current = uiMultiplier;
    target = newUIMultiplier;
    forwardLooking = true;
  } else if (mismatch) {
    current = uiMultiplier;
    target = registryMultiplier;
    // The registry and the chain already disagree: the change has landed on one
    // side, so this is a present-tense divergence, not a preview.
    forwardLooking = false;
  } else {
    // REST-only: no multiplier move to report, but the process date is still
    // forward-looking information a vault wants.
    current = uiMultiplier ?? parseFixed18("1") ?? 1n;
    target = current;
    forwardLooking = true;
  }

  const ratio = roundRatio(Number(target) / Number(current));
  if (!Number.isFinite(ratio) || ratio <= 0) return null;

  const zScore = ratio === 1 ? 0 : roundRatio(ratio >= 1 ? ratio - 1 : -(1 / ratio - 1));

  const onChainEvidence = scheduled || mismatch;
  const restEvidence = pendingActions.length > 0;
  const confidence: Confidence = onChainEvidence && restEvidence ? "HIGH" : "MED";

  const effectiveDate = fmtEffectiveDate(
    scheduled ? effectiveAtSec : null,
    classifyingAction?.processDate ?? null,
  );
  const actionType = classifyActionType(classifyingAction, ratio);
  const beforeItLands =
    forwardLooking &&
    (scheduled
      ? effectiveAtSec === null || effectiveAtSec * 1000 > now.getTime()
      : classifyingAction !== null);

  const explanation = buildExplanation({
    symbol: asset.symbol,
    scheduled,
    mismatch,
    current: fmtMultiplier(current),
    target: fmtMultiplier(target),
    effectiveDate,
    actionType,
    beforeItLands,
    classifyingAction,
    restEvidence,
  });

  const sources = buildSources({
    asset,
    scheduled,
    mismatch,
    current,
    target,
    effectiveAtSec,
    registryMultiplier,
    actions,
    window,
  });

  return {
    ticker: asset.symbol,
    tokenAddress: asset.tokenAddress,
    kind: "CORPORATE_ACTION",
    magnitude: ratio,
    zScore,
    confidence,
    explanation,
    evidence: {
      // No chain logs are read: the multiplier trio is a state read mirrored
      // through the universe table, and the classification is REST.
      fromBlock: 0,
      toBlock: 0,
      observed: ratio,
      baseline: 1,
      sampleSize: 0,
    },
    sources,
    window: CORPORATE_ACTION_WINDOW_ISO,
  };
}

/** The action type in words: the REST type when it is known, else inferred from
 *  the multiplier ratio, else a neutral phrase. */
function classifyActionType(action: RhjCorporateAction | null, ratio: number): string | null {
  if (action !== null) {
    if (action.type === CORPORATE_ACTION_TYPE_CASH_DIVIDEND) {
      return action.cashDividendRate !== null
        ? `a cash dividend, rate ${action.cashDividendRate}`
        : "a cash dividend";
    }
    const split = splitLabelFromRatio(ratio);
    if (split !== null) return `a ${split}`;
    // A typed action we do not have a friendly name for. Carry the raw type
    // rather than dropping it (matches the loose `/rhj` schema's intent).
    return action.type;
  }
  const split = splitLabelFromRatio(ratio);
  return split !== null ? `a ${split}` : null;
}

function buildExplanation(input: {
  symbol: string;
  scheduled: boolean;
  mismatch: boolean;
  current: string;
  target: string;
  effectiveDate: string;
  actionType: string | null;
  beforeItLands: boolean;
  classifyingAction: RhjCorporateAction | null;
  restEvidence: boolean;
}): string {
  const parts: string[] = [];
  const typeClause = input.actionType !== null ? ` ${input.actionType}.` : "";

  if (input.scheduled) {
    parts.push(
      `Scheduled multiplier change visible on-chain for ${input.symbol}: ${input.current} to ${input.target} effective ${input.effectiveDate}.${typeClause}` +
        (input.beforeItLands ? " visible before it lands." : ""),
    );
  } else if (input.mismatch) {
    parts.push(
      `On-chain uiMultiplier (${input.current}) disagrees with the Robinhood registry value (${input.target}) for ${input.symbol}.${typeClause}` +
        " a corporate action has been applied on one side and not the other.",
    );
  } else {
    parts.push(
      `Robinhood's corporate-actions feed lists ${input.actionType ?? "a corporate action"} for ${input.symbol}, process date ${input.effectiveDate}.` +
        " no on-chain multiplier change is scheduled yet.",
    );
  }

  if (input.restEvidence && (input.scheduled || input.mismatch)) {
    const action = input.classifyingAction;
    parts.push(
      `Robinhood's corporate-actions feed lists a matching ${action?.type ?? "entry"} in progress.`,
    );
  } else if ((input.scheduled || input.mismatch) && input.classifyingAction === null) {
    parts.push("Robinhood's corporate-actions feed has no entry for it yet.");
  }

  return parts.join(" ");
}

function buildSources(input: {
  asset: SignalAsset;
  scheduled: boolean;
  mismatch: boolean;
  current: bigint;
  target: bigint;
  effectiveAtSec: number | null;
  registryMultiplier: bigint | null;
  actions: readonly RhjCorporateAction[];
  window: TimeWindow;
}): string[] {
  const sources: string[] = [`token ${input.asset.tokenAddress}`];

  if (input.scheduled) {
    sources.push(
      `on-chain uiMultiplier=${fmtMultiplier(input.current)} newUIMultiplier=${fmtMultiplier(input.target)} effectiveAt=${input.effectiveAtSec ?? 0}`,
    );
  }
  if (input.mismatch && input.registryMultiplier !== null) {
    sources.push(`on-chain uiMultiplier=${fmtMultiplier(input.current)}`);
    sources.push(
      `${RHJ_ASSETS_ENDPOINT} symbol=${input.asset.symbol} currentMultiplier=${fmtMultiplier(input.registryMultiplier)}`,
    );
  }

  if (input.actions.length === 0) {
    sources.push(`${RHJ_CORPORATE_ACTIONS_ENDPOINT} (no entry for ${input.asset.symbol})`);
  } else {
    for (const action of input.actions) {
      const rate = action.cashDividendRate !== null ? ` rate=${action.cashDividendRate}` : "";
      sources.push(
        `${RHJ_CORPORATE_ACTIONS_ENDPOINT} id=${action.id} type=${action.type} status=${action.status} processDate=${action.processDate}${rate}`,
      );
    }
  }

  sources.push(`window ${input.window.start.toISOString()} to ${input.window.end.toISOString()}`);
  return sources;
}

interface UniverseMultiplierExtras {
  uiMultiplier: string;
  newUIMultiplier: string;
  multiplierEffectiveAt: number | null;
  registryMultiplier: string;
  multiplierMismatch: boolean;
}

export const corporateActionProcessor: SignalProcessor = {
  kind: "CORPORATE_ACTION",
  async compute(ctx: ProcessorContext, window: TimeWindow): Promise<SignalCandidate[]> {
    const log = ctx.logger.child({ module: "signals/corporate-action" });

    const rows = await ctx.db
      .select({
        tokenAddress: universe.tokenAddress,
        uiMultiplier: universe.uiMultiplier,
        newUIMultiplier: universe.newUIMultiplier,
        multiplierEffectiveAt: universe.multiplierEffectiveAt,
        registryMultiplier: universe.registryMultiplier,
        multiplierMismatch: universe.multiplierMismatch,
      })
      .from(universe)
      .where(eq(universe.signalEligible, true));

    const extras = new Map<string, UniverseMultiplierExtras>();
    for (const row of rows) {
      extras.set(row.tokenAddress.toLowerCase(), {
        uiMultiplier: row.uiMultiplier,
        newUIMultiplier: row.newUIMultiplier,
        multiplierEffectiveAt: row.multiplierEffectiveAt,
        registryMultiplier: row.registryMultiplier,
        multiplierMismatch: row.multiplierMismatch,
      });
    }

    let actions: RhjCorporateAction[] = [];
    try {
      actions = await fetchCorporateActions();
    } catch (err) {
      // The classification feed is unreachable this tick. The on-chain
      // multiplier reads are independent of it, so a scheduled change or a
      // mismatch still fires, just without the split/dividend label.
      log.warn("corporate-action: /rhj/corporate-actions unreachable, classifying without it", {
        err,
      });
    }

    const actionsByAddress = new Map<string, RhjCorporateAction[]>();
    for (const action of actions) {
      // Match on address, never on symbol (global do-not 3).
      const key = action.address.toLowerCase();
      const list = actionsByAddress.get(key);
      if (list) list.push(action);
      else actionsByAddress.set(key, [action]);
    }

    const candidates: SignalCandidate[] = [];
    for (const asset of ctx.assets) {
      const extra = extras.get(asset.tokenAddress.toLowerCase());
      if (!extra) continue;

      const candidate = evaluateCorporateAction({
        asset,
        multipliers: {
          uiMultiplier: parseFixed18(extra.uiMultiplier),
          newUIMultiplier: parseFixed18(extra.newUIMultiplier),
          effectiveAtSec: extra.multiplierEffectiveAt,
          registryMultiplier: parseFixed18(extra.registryMultiplier),
          multiplierMismatch: extra.multiplierMismatch,
        },
        actions: actionsByAddress.get(asset.tokenAddress.toLowerCase()) ?? [],
        window,
        now: window.end,
      });
      if (candidate) candidates.push(candidate);
    }

    log.info("corporate-action computed", {
      assets: ctx.assets.length,
      actionsFetched: actions.length,
      emitted: candidates.length,
    });
    return candidates;
  },
};

registerProcessor(corporateActionProcessor);
