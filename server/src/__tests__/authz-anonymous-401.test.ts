import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { getAccessibleResource } from "../routes/authz.js";

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status: vi.fn(), json: vi.fn() };
  res.status.mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json.mockImplementation((body: unknown) => { res.body = body; return res; });
  return res;
}
const anonymous = { actor: { type: "none", source: "none" } } as unknown as Request;

describe("getAccessibleResource", () => {
  it("throws 401 for an unauthenticated actor whether the resource exists, is missing, or its lookup fails", async () => {
    for (const resource of [Promise.resolve({ companyId: "c1" }), Promise.resolve(null), Promise.reject(new Error("db down"))]) {
      const res = fakeRes();
      await expect(getAccessibleResource(anonymous, res as unknown as Response, resource, "Issue not found"))
        .rejects.toMatchObject({ status: 401, message: "Authentication required" });
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it("keeps the existence-hiding 404 for an authenticated agent of another company", async () => {
    const res = fakeRes();
    const req = { method: "GET", actor: { type: "agent", agentId: "a1", companyId: "other", source: "agent_key" } } as unknown as Request;
    expect(await getAccessibleResource(req, res as unknown as Response, Promise.resolve({ companyId: "c1" }), "Issue not found")).toBeNull();
    expect(res.statusCode).toBe(404);
  });

  it("returns the resource for an authenticated agent of the same company", async () => {
    const res = fakeRes();
    const req = { method: "GET", actor: { type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" } } as unknown as Request;
    expect(await getAccessibleResource(req, res as unknown as Response, Promise.resolve({ companyId: "c1" }), "Issue not found")).toEqual({ companyId: "c1" });
  });
});
