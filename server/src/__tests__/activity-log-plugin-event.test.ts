import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  activityLoggedPluginEvent,
  publishActivity,
  setPluginEventBus,
  type ActivityPublication,
} from "../services/activity-log.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";

const companyId = "00000000-0000-4000-8000-0000000000aa";

function publication(overrides: Partial<ActivityPublication> = {}): ActivityPublication {
  return {
    companyId,
    payload: {
      actorType: "agent",
      actorId: "agent-1",
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: "issue-1",
      agentId: "agent-1",
      runId: null,
      responsibleUserId: null,
      details: { interactionId: "interaction-1", effectiveResolverPolicy: "human_only" },
    },
    pluginEvent: null,
    ...overrides,
  };
}

describe("activity.logged plugin event", () => {
  it("mirrors the redacted activity payload with the activity's entity", () => {
    const event = activityLoggedPluginEvent(publication());
    expect(event).toMatchObject({
      eventType: "activity.logged",
      companyId,
      actorType: "agent",
      actorId: "agent-1",
      entityType: "issue",
      entityId: "issue-1",
      payload: {
        action: "issue.thread_interaction_created",
        details: { interactionId: "interaction-1", effectiveResolverPolicy: "human_only" },
      },
    });
  });

  it("returns null for a payload without an action", () => {
    expect(activityLoggedPluginEvent(publication({ payload: {} }))).toBeNull();
  });

  it("publishes activity.logged for unmapped actions and alongside typed events", async () => {
    const emitted: PluginEvent[] = [];
    setPluginEventBus({
      emit: async (event: PluginEvent) => {
        emitted.push(event);
        return { errors: [] };
      },
    } as unknown as PluginEventBus);

    publishActivity(publication());
    const typed: PluginEvent = {
      eventId: "typed-1",
      eventType: "approval.decided",
      occurredAt: new Date().toISOString(),
      entityId: "approval-1",
      entityType: "approval",
      companyId,
      payload: {},
    };
    publishActivity(publication({
      payload: { action: "approval.approved", entityType: "approval", entityId: "approval-1" },
      pluginEvent: typed,
    }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(emitted.map((event) => [event.eventType, event.payload && (event.payload as Record<string, unknown>).action]))
      .toEqual([
        ["activity.logged", "issue.thread_interaction_created"],
        ["approval.decided", undefined],
        ["activity.logged", "approval.approved"],
      ]);
  });
});
