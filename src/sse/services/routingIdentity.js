import { createRoutingIdentity, routingCaller } from "open-sse/services/sessionAffinity.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";

export function getRoutingIdentity(request, apiKey, body) {
  return createRoutingIdentity(body, request.headers, routingCaller(apiKey, apiKey ? null : getClientIp(request)));
}
