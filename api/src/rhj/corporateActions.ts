import { fetchJson } from "./client.ts";
import {
  corporateActionsResponseWire,
  toRhjCorporateAction,
  type RhjCorporateAction,
} from "./types.ts";

/**
 * `GET /corporate-actions` — typed actions with a process date, which is what
 * lets BE-13 say "CRWD multiplier goes 1 to 4 on <date>, 4:1 split" before the
 * jump lands instead of reporting it afterwards.
 */

export const CORPORATE_ACTION_STATUS_IN_PROGRESS = "CORPORATE_ACTION_STATUS_IN_PROGRESS";
export const CORPORATE_ACTION_TYPE_CASH_DIVIDEND = "CORPORATE_ACTION_TYPE_CASH_DIVIDEND";

/**
 * Every corporate action upstream serves, completed ones included. Filtering is
 * the caller's decision. Throws `RhjError` on failure, never returns `[]`.
 */
export async function fetchCorporateActions(): Promise<RhjCorporateAction[]> {
  const response = await fetchJson({
    path: "/corporate-actions",
    endpoint: "corporate-actions",
    schema: corporateActionsResponseWire,
  });

  return response.corpActions.map(toRhjCorporateAction);
}

/** The subset that has not landed yet. These are the ones worth a signal. */
export async function fetchPendingCorporateActions(): Promise<RhjCorporateAction[]> {
  const actions = await fetchCorporateActions();
  return actions.filter((action) => action.status === CORPORATE_ACTION_STATUS_IN_PROGRESS);
}
