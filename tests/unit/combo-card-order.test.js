import { describe, it, expect } from "vitest";
import {
  buildComboCardOrderIndexer,
  buildComboCardComparator,
  mergeComboCardOrder,
  moveComboCardInOrder,
  pinComboCardToTop,
} from "@/shared/utils/comboCardOrder";

describe("comboCardOrder utils", () => {
  const allKeys = ["combo-1", "combo-2", "combo-3", "combo-4"];

  describe("mergeComboCardOrder", () => {
    it("preserves manual order and appends newly discovered keys", () => {
      const order = ["combo-3", "combo-1"];
      const result = mergeComboCardOrder(order, allKeys);
      expect(result).toEqual(["combo-3", "combo-1", "combo-2", "combo-4"]);
    });
  });

  describe("moveComboCardInOrder", () => {
    it("moves sourceId to targetId's slot", () => {
      const order = ["combo-1", "combo-2", "combo-3", "combo-4"];
      const result = moveComboCardInOrder(order, allKeys, "combo-4", "combo-2");
      expect(result).toEqual(["combo-1", "combo-4", "combo-2", "combo-3"]);
    });

    it("returns same array reference if source and target are identical or invalid", () => {
      const order = ["combo-1", "combo-2"];
      expect(moveComboCardInOrder(order, allKeys, "combo-1", "combo-1")).toBe(order);
      expect(moveComboCardInOrder(order, allKeys, "", "combo-1")).toBe(order);
      expect(moveComboCardInOrder(order, allKeys, "combo-1", null)).toBe(order);
    });
  });

  describe("pinComboCardToTop", () => {
    it("moves designated combo to index 0", () => {
      const order = ["combo-1", "combo-2", "combo-3"];
      const result = pinComboCardToTop(order, allKeys, "combo-3");
      expect(result).toEqual(["combo-3", "combo-1", "combo-2", "combo-4"]);
    });

    it("returns same array reference if already at index 0", () => {
      const order = ["combo-1", "combo-2", "combo-3"];
      expect(pinComboCardToTop(order, allKeys, "combo-1")).toBe(order);
    });

    it("unshifts combo to front if not previously in order array", () => {
      const order = ["combo-2", "combo-3"];
      const result = pinComboCardToTop(order, allKeys, "combo-4");
      expect(result[0]).toBe("combo-4");
    });
  });

  describe("buildComboCardComparator", () => {
    it("sorts by cardOrder index first", () => {
      const cardOrder = ["c3", "c1", "c2"];
      const comparator = buildComboCardComparator({ cardOrder });

      const combos = [
        { id: "c1", name: "Alpha", createdAt: "2026-01-01" },
        { id: "c2", name: "Beta", createdAt: "2026-01-02" },
        { id: "c3", name: "Gamma", createdAt: "2026-01-03" },
      ];

      combos.sort(comparator);
      expect(combos.map((c) => c.id)).toEqual(["c3", "c1", "c2"]);
    });

    it("tie-breaks by createdAt (earliest first) when not in cardOrder", () => {
      const comparator = buildComboCardComparator({ cardOrder: [] });

      const combos = [
        { id: "c1", name: "Alpha", createdAt: "2026-02-01T00:00:00Z" },
        { id: "c2", name: "Beta", createdAt: "2026-01-01T00:00:00Z" },
      ];

      combos.sort(comparator);
      expect(combos.map((c) => c.id)).toEqual(["c2", "c1"]);
    });

    it("tie-breaks by name alphabetically if createdAt is missing or identical", () => {
      const comparator = buildComboCardComparator({ cardOrder: [] });

      const combos = [
        { id: "c2", name: "Zeta" },
        { id: "c1", name: "Alpha" },
      ];

      combos.sort(comparator);
      expect(combos.map((c) => c.id)).toEqual(["c1", "c2"]);
    });
  });
});
