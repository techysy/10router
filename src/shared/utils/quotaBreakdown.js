import { isSummaryRow } from "./quotaRows.js";

/**
 * A detail list can replace a pool bar only when it describes the whole pool.
 * Status rows (e.g. check-in) and partial top-up lists are not balance segments.
 * Return normalized segments, or [] so callers retain the authoritative pool.
 */
export function completeQuotaBreakdown(rows = [], pool = []) {
  const normalize = (row) => ({
    ...row,
    totalNum: Number(row.totalNum ?? row.total ?? 0),
    remainingNum: Math.max(0, Number(row.remainingNum ?? row.remaining ??
      (Number(row.total || 0) - Number(row.used || 0)))),
  });
  const breakdown = rows
    .filter((row) => row && typeof row === "object" && row.detailOnly === true && !isSummaryRow(row))
    .map(normalize)
    .filter((row) => row.totalNum !== 0 || row.remainingNum !== 0);
  if (!pool.length || !breakdown.length) return [];
  const normalizedPool = pool.map(normalize);
  if ([...breakdown, ...normalizedPool].some((row) =>
    !Number.isFinite(row.totalNum) || row.totalNum < 0 ||
    !Number.isFinite(row.remainingNum) || row.remainingNum > row.totalNum)) return [];

  // Only tolerate floating-point addition noise, not missing credits. Comparing
  // both totals and remaining balances also catches a partial or stale usage list.
  for (const key of ["totalNum", "remainingNum"]) {
    const detail = breakdown.reduce((sum, row) => sum + row[key], 0);
    const aggregate = normalizedPool.reduce((sum, row) => sum + row[key], 0);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(detail), Math.abs(aggregate)) * (breakdown.length + pool.length) * 4;
    if (Math.abs(detail - aggregate) > tolerance) return [];
  }
  return breakdown;
}
