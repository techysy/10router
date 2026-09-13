/**
 * Night-free window check (codebuddy-cn hy4-preview: free 23:00–08:00 local).
 * Pure and JSX-free so unit tests can import it without pulling the component
 * tree (vitest does not transform JSX inside .js files).
 */

/**
 * True when the local hour falls inside the night-free window. The window may
 * wrap midnight (from=23, to=8 → night is [23:00, 08:00)); `from` is inclusive,
 * `to` exclusive. Missing/invalid input → false (no free claim).
 */
export function isNightFreeHour(hour, window) {
  if (!window || typeof hour !== "number" || Number.isNaN(hour)) return false;
  const { from, to } = window;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}
