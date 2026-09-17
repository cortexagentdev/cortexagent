// shared/format.ts

/* The display formatters that more than one runtime needs.

   The terminal formats a contract value for the DOM; the card renderer formats
   the same value into a PNG in the api process, with none of the UI's code
   loaded. A signal's magnitude has to read identically in both, so the functions
   live here rather than being implemented twice. `src/components/dash/format.ts`
   re-exports these and keeps the browser-only projections beside them. */

import type { SignalKind } from "./contracts.ts";

/** USD. null renders as "-", never as $0: an unreadable value is not zero. */
export function formatUsd(n: number | null, opts?: { compact?: boolean; sign?: boolean }): string {
  if (n === null) return "-";
  const sign = n < 0 ? "-" : opts?.sign ? "+" : "";
  const abs = Math.abs(n);
  if (opts?.compact) {
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Percent value already in percent units. null renders as "-". */
export function formatPct(n: number | null, opts?: { sign?: boolean }): string {
  if (n === null) return "-";
  const lead = opts?.sign && n >= 0 ? "+" : "";
  return `${lead}${n}%`;
}

/* `formatFeedAge` and `formatAge` deliberately stay in the terminal's own
   format.ts. A card states an absolute "as of" instant rather than an age: the
   image is cached, then sits in a chat log for weeks, and "4m ago" baked into a
   PNG would keep claiming to be fresh long after it stopped being true. */

/** ISO timestamp to a stable absolute label in UTC. Deterministic across SSR
   and client, unlike a locale string, and precise enough to cite a signal. */
export function formatAbsolute(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A signed signal value in the unit its kind is measured in: USD for FLOW and
   LIQUIDITY_SHIFT, percent for PEG_DRIFT and AFTER_HOURS_DISLOCATION, percentage
   points for HOLDER_CONCENTRATION, a ratio for CORPORATE_ACTION. Used for
   `magnitude` and for the observed / baseline evidence values. */
export function formatMagnitude(
  kind: SignalKind,
  value: number,
  opts?: { sign?: boolean },
): string {
  const sign = opts?.sign ?? true;
  switch (kind) {
    case "FLOW":
    case "LIQUIDITY_SHIFT":
      return formatUsd(value, { compact: true, sign });
    case "PEG_DRIFT":
    case "AFTER_HOURS_DISLOCATION":
      return formatPct(value, { sign });
    case "HOLDER_CONCENTRATION": {
      const lead = value < 0 ? "-" : sign ? "+" : "";
      return `${lead}${Math.abs(value)} pp`;
    }
    case "CORPORATE_ACTION":
      return `${value}:1`;
  }
}

/** The display label for a signal kind. The terminal pairs each with a colour;
 *  the card needs the same words without the Tailwind-facing style map. */
export const SIGNAL_KIND_LABEL: Record<SignalKind, string> = {
  FLOW: "FLOW",
  PEG_DRIFT: "PEG DRIFT",
  LIQUIDITY_SHIFT: "LIQUIDITY",
  HOLDER_CONCENTRATION: "HOLDERS",
  AFTER_HOURS_DISLOCATION: "AFTER HRS",
  CORPORATE_ACTION: "CORP ACT",
};

/** The colour each signal kind is keyed to, shared by the terminal's pills and
 *  the card's accent so a FLOW card is the same blue in a tweet and in the app. */
export const SIGNAL_KIND_COLOR: Record<SignalKind, string> = {
  FLOW: "#4A6FFF",
  PEG_DRIFT: "#F1557C",
  LIQUIDITY_SHIFT: "#56CCF2",
  HOLDER_CONCENTRATION: "#8A5CFF",
  AFTER_HOURS_DISLOCATION: "#FF9A5C",
  CORPORATE_ACTION: "#0D0D12",
};
