import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { getAccessibleResource } from "../routes/authz.js";

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status: vi.fn(), json: vi.fn() };
  res.status.mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json.mockImplementation((body: unknown) => { res.body = body; return res; });
  return res;
}

describe("getAccessibleResource", () => {
  it("returns 401 for an unauthenticated actor whether or not the resource exists", async () => {
    for (const resource of [{ companyId: "c1" }, null]) {
      const res = fakeRes();
      const out = await getAccessibleResource({ actor: { type: "none", source: "none" } } as unknown as Request, res as unknown as Response, Promise.resolve(resource), "Issue not found");
      expect(out).toBeNull();
      expect(res.statusCode).toBe(401);
      expect(JSON.stringify(res.body)).toContain("Bearer");
    }
  });

  it("keeps the existence-hiding 404 for an authenticated agent of another company", async () => {
    const res = fakeRes();
    const req = { method: "GET", actor: { type: "agent", agentId: "a1", companyId: "other", source: "agent_key" } } as unknown as Request;
    const out = await getAccessibleResource(req, res as unknown as Response, Promise.resolve({ companyId: "c1" }), "Issue not found");
    expect(out).toBeNull();
    expect(res.statusCode).toBe(404);
  });
});
