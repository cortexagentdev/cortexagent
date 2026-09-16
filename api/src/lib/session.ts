/**
 * BE-7: US equity market calendar and session state.
 *
 * The calendar is a static file in the repo (`api/data/market-calendar.json`),
 * not an API call. NYSE and Nasdaq publish holidays and early closes years
 * ahead, so a fetch would add a dependency and a failure mode to answer a
 * question that is already settled (locked decision 7: free-tier data only).
 *
 * **The calendar file must be regenerated yearly.** It currently covers 2026 and
 * 2027. Past the last covered year every day looks like a trading day, so
 * holidays would silently read as `rth`. `getSession` logs a warning once per
 * uncovered year rather than failing: a market-intelligence terminal that
 * throws on New Year's Eve is worse than one that says so in the log.
 *
 * ## Sessions
 *
 * Boundaries are in `America/New_York` and DST-aware. The conversion goes
 * through `Intl.DateTimeFormat` with an explicit `timeZone`, never a hardcoded
 * offset: ET is UTC-5 in winter and UTC-4 in summer, and a fixed offset would
 * mislabel every session for months at a time in the wrong direction by a full
 * hour, which is exactly the width of the pre-market open.
 *
 * | Session | ET window |
 * | --- | --- |
 * | `pre` | 04:00 to 09:30 |
 * | `rth` | 09:30 to 16:00 (or the early close on a half-day) |
 * | `after` | 16:00 (or the early close) to 20:00 |
 * | `closed` | otherwise, plus weekends and holidays |
 *
 * ## Halts are not calendar events
 *
 * A per-name trading halt comes from `isTradingHalt` on `/rhj/prices` and is
 * entirely separate from this calendar. A halted name during RTH is *not*
 * "after hours": the market is open and that one name is not trading. Consumers
 * that care about tradability must check both, and neither one substitutes for
 * the other. `AFTER_HOURS_DISLOCATION` in particular is suppressed by a halt
 * rather than explained by it.
 */

import { z } from "zod";

import type { MarketSession } from "@shared/contracts.ts";

import { logger } from "./logger.ts";
import calendarJson from "../../data/market-calendar.json";

const log = logger.child({ module: "lib/session" });

/** Minutes past ET midnight for each fixed boundary. */
const PRE_OPEN_MIN = 4 * 60; // 04:00
const RTH_OPEN_MIN = 9 * 60 + 30; // 09:30
const RTH_CLOSE_MIN = 16 * 60; // 16:00
const AFTER_CLOSE_MIN = 20 * 60; // 20:00

const halfDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  closeEt: z.string().regex(/^\d{2}:\d{2}$/),
});

const calendarSchema = z.object({
  version: z.string().min(1),
  source: z.string().min(1).optional(),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  halfDays: z.array(halfDaySchema),
});

interface Calendar {
  version: string;
  holidays: Set<string>;
  /** ET date -> minutes past midnight at which RTH ends that day. */
  halfDays: Map<string, number>;
  /** Years the file covers, derived from its own entries. */
  coveredYears: Set<string>;
}

function loadCalendar(): Calendar {
  const parsed = calendarSchema.safeParse(calendarJson);
  if (!parsed.success) {
    // An unparseable calendar would make every holiday a trading day. Fail loud
    // at import rather than mislabel sessions for a year.
    throw new Error(`data/market-calendar.json failed to parse: ${parsed.error.message}`);
  }

  const holidays = new Set(parsed.data.holidays);
  const halfDays = new Map<string, number>();
  for (const entry of parsed.data.halfDays) {
    const [hour, minute] = entry.closeEt.split(":").map(Number);
    halfDays.set(entry.date, hour * 60 + minute);
  }

  const coveredYears = new Set<string>();
  for (const date of [...holidays, ...halfDays.keys()]) coveredYears.add(date.slice(0, 4));

  return { version: parsed.data.version, holidays, halfDays, coveredYears };
}

const calendar = loadCalendar();

/** The calendar file's own version string, for surfacing in ops output. */
export const MARKET_CALENDAR_VERSION = calendar.version;

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

interface EtClock {
  /** `YYYY-MM-DD` in ET. */
  date: string;
  /** Minutes past ET midnight. */
  minutes: number;
  isWeekend: boolean;
}

function toEtClock(at: Date): EtClock {
  const parts: Record<string, string> = {};
  for (const part of etFormatter.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const isWeekend = parts.weekday === "Sat" || parts.weekday === "Sun";

  return { date, minutes, isWeekend };
}

const warnedYears = new Set<string>();

function warnIfUncovered(date: string): void {
  const year = date.slice(0, 4);
  if (calendar.coveredYears.has(year) || warnedYears.has(year)) return;
  warnedYears.add(year);
  log.warn("market calendar does not cover this year, holidays will read as trading days", {
    year,
    calendarVersion: calendar.version,
  });
}

/**
 * The US equity session at an instant, in `America/New_York`.
 *
 * Weekends and listed holidays are `closed` at every hour. On a half-day, `rth`
 * ends at the listed early close and `after` runs from there to 20:00 ET.
 */
export function getSession(at: Date): MarketSession {
  const { date, minutes, isWeekend } = toEtClock(at);
  warnIfUncovered(date);

  if (isWeekend || calendar.holidays.has(date)) return "closed";

  const rthClose = calendar.halfDays.get(date) ?? RTH_CLOSE_MIN;

  if (minutes < PRE_OPEN_MIN) return "closed";
  if (minutes < RTH_OPEN_MIN) return "pre";
  if (minutes < rthClose) return "rth";
  if (minutes < AFTER_CLOSE_MIN) return "after";
  return "closed";
}

/**
 * What `Signal.afterHours` means: the equity market was not in its regular
 * session when the signal fired. Pre-market, after-hours and overnight are all
 * true. This says nothing about whether one name was halted.
 */
export function isAfterHours(at: Date): boolean {
  return getSession(at) !== "rth";
}

/** Whether the calendar has entries for the ET year containing `at`. */
export function isCalendarCovered(at: Date): boolean {
  return calendar.coveredYears.has(toEtClock(at).date.slice(0, 4));
}
