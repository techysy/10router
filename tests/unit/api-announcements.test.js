import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/announcements/route.js";

describe("GET /api/announcements", () => {
  it("returns 200 and a valid feed with bundled announcements fallback", async () => {
    const res = await GET(new Request("http://localhost/api/announcements"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("items");
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items[0]).toHaveProperty("id");
    expect(data.items[0]).toHaveProperty("title");
  });

  it("sets cache headers properly", async () => {
    const res = await GET(new Request("http://localhost/api/announcements"));
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
  });
});
