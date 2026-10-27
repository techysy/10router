// Shared combo-card ordering + drag-reorder & pin-to-top model.
//
// Maintains the manual display order of model combos across the dashboard and
// API models list (/v1/models), persisted in settings.comboCardOrder.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Index lookup for the manual order; ids absent from it sort after every known one. */
export function buildComboCardOrderIndexer(cardOrder = []) {
  const pos = new Map();
  (cardOrder || []).forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, i); // first occurrence wins
  });
  return (key) => (pos.has(key) ? pos.get(key) : MAX_SAFE);
}

/**
 * Build a comparator over combos (objects with id, name, createdAt, or plain string ids).
 *
 * Order precedence:
 *   1. Manual card order (settings.comboCardOrder)
 *   2. Creation date (earliest created first)
 *   3. Name (alphabetical)
 *
 * @param {object}   opts
 * @param {string[]} [opts.cardOrder] - manual order of combo IDs
 * @returns {(a: object|string, b: object|string) => number}
 */
export function buildComboCardComparator({ cardOrder = [] } = {}) {
  const orderIndex = buildComboCardOrderIndexer(cardOrder);

  return (a, b) => {
    const idA = typeof a === "object" && a !== null ? a.id : a;
    const idB = typeof b === "object" && b !== null ? b.id : b;

    const oa = orderIndex(idA);
    const ob = orderIndex(idB);
    if (oa !== ob) return oa - ob;

    // Tie-break 1: createdAt (if available)
    const timeA = typeof a === "object" && a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = typeof b === "object" && b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (timeA && timeB && timeA !== timeB) return timeA - timeB;

    // Tie-break 2: name
    const nameA = typeof a === "object" && a?.name ? a.name : String(a ?? "");
    const nameB = typeof b === "object" && b?.name ? b.name : String(b ?? "");
    return nameA.localeCompare(nameB);
  };
}

/** Grow the manual order with every known key, preserving first-seen order. */
export function mergeComboCardOrder(cardOrder, allKeys) {
  const base = [...(cardOrder || [])];
  for (const key of allKeys || []) {
    if (!base.includes(key)) base.push(key);
  }
  return base;
}

/**
 * Pure reorder: move `sourceId` to `targetId`'s slot.
 * Returns the SAME array reference for a no-op (missing/same id) so callers can skip persist.
 */
export function moveComboCardInOrder(cardOrder, allKeys, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return cardOrder;
  const base = mergeComboCardOrder(cardOrder, allKeys);
  const fromIdx = base.indexOf(sourceId);
  const toIdx = base.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return cardOrder;
  base.splice(fromIdx, 1);
  base.splice(toIdx, 0, sourceId);
  return base;
}

/**
 * Quick pin to top: move `comboId` to the very top (index 0).
 * Returns the SAME array reference if already at index 0 or invalid id.
 */
export function pinComboCardToTop(cardOrder, allKeys, comboId) {
  if (!comboId) return cardOrder;
  const base = mergeComboCardOrder(cardOrder, allKeys);
  const fromIdx = base.indexOf(comboId);
  if (fromIdx === 0) return cardOrder;
  if (fromIdx === -1) {
    base.unshift(comboId);
    return base;
  }
  base.splice(fromIdx, 1);
  base.unshift(comboId);
  return base;
}

/** Persist the manual combo order (fire-and-forget: caller already updated state). */
export function saveComboCardOrder(base) {
  return fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comboCardOrder: base }),
  });
}
