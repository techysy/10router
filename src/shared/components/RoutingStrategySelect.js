"use client";

import { useEffect, useState } from "react";
import Select from "./Select";
import { getCurrentLocale, onLocaleChange, translate } from "@/i18n/runtime";
import { ROUND_ROBIN, SESSION_ROUND_ROBIN } from "open-sse/config/routingStrategies.js";

const TIME = {
  label: "Round Robin — by time",
  description: "Rotate combo members after an idle window or at the request limit.",
};
const COUNT = {
  label: "Round Robin — by request count",
  description: "Keep the same account for the configured number of consecutive requests, then rotate to the next available account.",
};
const SESSION = {
  label: "Round Robin — by session",
  description: "New sessions rotate; each session keeps its last successful choice for up to 30 idle minutes. If that choice is unavailable, the next success takes over. Requests without a session use the ordinary rotation.",
};

export function useRoutingLocale() {
  const [, setLocale] = useState(getCurrentLocale);
  useEffect(() => onLocaleChange(() => setLocale(getCurrentLocale())), []);
}

export function RoutingStrategySelect({ layer, options, value, title, accessibleLabel = "Scheduling Preference", sessionEnabled = true, ...props }) {
  useRoutingLocale();
  const legacy = layer === "combo" ? TIME : COUNT;
  const localized = options.flatMap((option) => option.value === ROUND_ROBIN
    ? [
      { value: ROUND_ROBIN, label: translate(legacy.label) },
      ...(sessionEnabled ? [{ value: SESSION_ROUND_ROBIN, label: translate(SESSION.label) }] : []),
    ] : [{ ...option, label: option.label ? translate(option.label) : option.label }]);
  const help = value === ROUND_ROBIN ? legacy.description : value === SESSION_ROUND_ROBIN ? SESSION.description : null;
  return <Select {...props} aria-label={translate(accessibleLabel)} options={localized} value={value} title={title || (help ? translate(help) : undefined)} />;
}
