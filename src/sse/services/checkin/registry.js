// Check-in adapter registry.
//
// One adapter per provider family. The scheduler imports this module once and
// sweeps every adapter whose settings toggle is on. Adding a provider means:
//   1. add `providers/<id>.js` exporting the adapter object,
//   2. import it below,
//   3. add its settings key to settingsRepo DEFAULT_SETTINGS (default false).
//
// Adapter contract:
//   {
//     id: "raccoon",                  // unique, used in logs + ledger
//     providers: ["raccoon"],         // connection.provider values it owns
//     settingsKey: "raccoonCheckin",  // boolean toggle in settings
//     cadence: "daily" | "claim",     // documentation only; scheduler treats both alike
//     run(conn, ctx) => Promise<{status, amount?, unit?, before?, after?, code?, message?}>
//   }
// status ∈ ok | already | no-activity | needs-reauth | limited | failed
// `ctx` = { settings, dryRun, today }.
import raccoon from "./providers/raccoon.js";
import atomcode from "./providers/atomcode.js";
import lobsterai from "./providers/lobsterai.js";
import loomy from "./providers/loomy.js";
import officeace from "./providers/officeace.js";
import codearts from "./providers/codearts.js";
import trae from "./providers/trae.js";

const ADAPTERS = [raccoon, atomcode, lobsterai, loomy, officeace, codearts, trae];

export function getCheckinAdapters() {
  return ADAPTERS;
}

/** Settings keys the settings route / boot code need to watch. */
export const CHECKIN_SETTING_KEYS = ADAPTERS.map((a) => a.settingsKey);
