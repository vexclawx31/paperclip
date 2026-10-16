import { describe, expect, it } from "vitest";
import {
  isHistoricalTaskQuestion,
  isHumanDirectionComment,
  isOrdinaryTaskQuestion,
  latestHumanDirectionComment,
} from "./task-questions.js";

const question = { kind: "ask_user_questions", createdAt: new Date("2026-08-15T12:00:00Z"), payload: { version: 1 } };
const human = {
  createdAt: new Date("2026-08-15T12:05:00Z"),
  authorType: "user",
  authorUserId: "user-1",
  authorAgentId: null,
  presentation: null,
};

describe("task question history", () => {
  it("makes an earlier ordinary question historical after a newer human message", () => {
    expect(isHistoricalTaskQuestion(question, latestHumanDirectionComment([human]))).toBe(true);
  });

  it("keeps a question current when the human message is older", () => {
    const older = { ...human, createdAt: new Date("2026-08-15T11:59:00Z") };
    expect(isHistoricalTaskQuestion(question, latestHumanDirectionComment([older]))).toBe(false);
  });

  it.each([
    ["agent-authored", { authorType: "agent", authorUserId: null, authorAgentId: "agent-1" }],
    ["agent with user attribution", { authorAgentId: "agent-1" }],
    ["run-attributed", { createdByRunId: "run-1" }],
    ["derived agent", { derivedAuthorAgentId: "agent-1" }],
    ["derived run", { derivedCreatedByRunId: "run-1" }],
    ["derived source", { derivedAuthorSource: "run_id" }],
    ["untrusted", { sourceTrust: { trust: "untrusted" } }],
    ["system notice", { presentation: { kind: "system_notice" } }],
    ["system author", { authorType: "system" }],
    ["deleted", { deletedAt: new Date("2026-08-15T12:06:00Z") }],
  ])("does not let a %s comment make it historical", (_label, override) => {
    const comment = { ...human, ...override };
    expect(isHumanDirectionComment(comment)).toBe(false);
    expect(isHistoricalTaskQuestion(question, latestHumanDirectionComment([comment]))).toBe(false);
  });

  it("never makes governed or non-question interactions historical", () => {
    for (const key of ["toolAction", "secretProposal", "connectionAuthorization"]) {
      const governed = { ...question, payload: { version: 1, [key]: {} } };
      expect(isOrdinaryTaskQuestion(governed)).toBe(false);
      expect(isHistoricalTaskQuestion(governed, human)).toBe(false);
    }
    expect(isHistoricalTaskQuestion({ ...question, kind: "request_confirmation" }, human)).toBe(false);
  });

  it("picks the newest human comment and ignores newer agent comments", () => {
    const agent = { ...human, authorType: "agent", authorUserId: null, authorAgentId: "a", createdAt: new Date("2026-08-15T13:00:00Z") };
    expect(latestHumanDirectionComment([human, agent])).toBe(human);
    expect(latestHumanDirectionComment([agent])).toBeNull();
  });
});
