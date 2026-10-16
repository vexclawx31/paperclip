// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
vi.mock("../lib/router", () => ({
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props} />,
}));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { resolveRecoveryAction: vi.fn() } }));

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    // The design-system checkbox measures itself.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "failed-run", agentId: "agent", status: "failed" }] as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  it("shows only the requested sentence, Retry, and Reconcile, inside a distinct recovery container", () => {
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toBe("Automatic recovery of this task stopped.RetryReconcile and continue");
    expect(notice.classList.contains("border")).toBe(true);
    expect(notice.classList.contains("bg-muted")).toBe(true);
    expect(notice.querySelector("a")).toBeNull();
  });
  it("keeps the required next action for other reconciliation causes", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "action_outcome_unknown",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Verify the external action outcome before continuing.");
    expect(container.textContent).not.toContain("Automatic recovery of this task stopped.");
    expect(container.textContent).not.toContain("Reconcile and continue");
  });
  it.each(["native_continuation_requires_reconciliation", "native_session_cleanup_quarantined"])("links to the source run instead of offering a retry rejected by %s", async (cause) => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent",
        cause,
        nextAction: "Inspect the original failure and reconcile the previous execution before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Recovery needed.");
    expect(container.textContent).not.toContain("Retry");
    expect(container.textContent).not.toContain("Reconcile and continue");
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Inspect run");
    expect(link.getAttribute("href")).toBe("/agents/agent/runs/failed-run");
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
  });
  it("retries the exact failed run and refreshes the task", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "failed-run", "company");
    expect(onRetried).toHaveBeenCalledOnce();
  });
  it("shows a failed Retry in the same container and allows another attempt", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });
  function buttonByText(text: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
  }
  function typeInto(element: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function radio(form: Element, title: string) {
    return [...form.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent?.includes(title))!;
  }
  async function renderCancelledHold(extra: Partial<ExecutionBlocker> = {}, runId = "cancelled-run") {
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([
      { runId: "cancelled-run", agentId: "agent", status: "cancelled" },
      { runId: "other-run", agentId: "agent", status: "cancelled" },
    ] as never);
    await act(async () => client.resetQueries());
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: `hold-${runId}`, runId, agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped.", ...extra,
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  async function fillValidForm(form: Element) {
    await act(async () => radio(form, "No actions were performed").click());
    await act(async () => typeInto(form.querySelector('textarea[aria-label="Outcome evidence"]')!, "Checked the run log; it stopped before any tool call."));
    await act(async () => form.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  }
  it("offers Reconcile and continue, not Retry, for a hold left by a cancelled run", async () => {
    await renderCancelledHold();
    expect(container.textContent).toBe("Automatic recovery of this task stopped.Reconcile and continue");
  });
  it("collects the action outcome and evidence, then restores the task to To do", async () => {
    vi.mocked(issuesApi.resolveRecoveryAction).mockResolvedValue({} as never);
    await renderCancelledHold();
    await act(async () => buttonByText("Reconcile and continue").click());
    const form = container.querySelector('form[aria-label="Reconcile stopped run"]')!;
    expect(form).not.toBeNull();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const footer = submit.parentElement!;
    // Cancel stays left of the primary action in the same footer row.
    expect([...footer.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Cancel", "Reconcile and continue"]);
    expect(submit.disabled).toBe(true);
    await act(async () => radio(form, "No actions were performed").click());
    await act(async () => typeInto(form.querySelector("textarea")!, "too short"));
    await act(async () => form.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    expect(submit.disabled).toBe(true);
    expect(form.textContent).toContain("Write at least 20 characters.");
    await act(async () => typeInto(form.querySelector("textarea")!, "  Checked the run log; it stopped before any tool call.  "));
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(issuesApi.resolveRecoveryAction).toHaveBeenCalledWith("task", {
      actionId: "hold-cancelled-run", outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: {
        runId: "cancelled-run", providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Checked the run log; it stopped before any tool call.",
      },
    });
    expect(onRetried).toHaveBeenCalledOnce();
    expect(container.querySelector("form")).toBeNull();
  });
  it("requires confirming that the provider stopped and keeps the form open on a server error", async () => {
    vi.mocked(issuesApi.resolveRecoveryAction).mockRejectedValue(new Error("The previous provider is still running. Stop it before continuing."));
    await renderCancelledHold();
    await act(async () => buttonByText("Reconcile and continue").click());
    const form = container.querySelector("form")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => radio(form, "Some actions completed").click());
    await act(async () => typeInto(form.querySelector("textarea")!, "Two of three emails were sent; verified in the outbox."));
    expect(submit.disabled).toBe(true);
    await act(async () => form.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    await act(async () => submit.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(form.querySelector('[role="alert"]')?.textContent).toBe("The previous provider is still running. Stop it before continuing.");
    expect(container.querySelector("form")).not.toBeNull();
    expect(onRetried).not.toHaveBeenCalled();
    await act(async () => buttonByText("Cancel").click());
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Reconcile and continue");
  });
  it("requires workspace repair evidence when the server reports a workspace restore failure", async () => {
    vi.mocked(issuesApi.resolveRecoveryAction).mockResolvedValue({} as never);
    await renderCancelledHold({ workspaceRepairRequired: true });
    await act(async () => buttonByText("Reconcile and continue").click());
    const form = container.querySelector("form")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await fillValidForm(form);
    expect(submit.disabled).toBe(true);
    await act(async () => typeInto(form.querySelector('textarea[aria-label="Workspace repair evidence"]')!, "  Verified fresh confined staging after repair.  "));
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(issuesApi.resolveRecoveryAction).toHaveBeenCalledWith("task", expect.objectContaining({
      executionReconciliation: expect.objectContaining({ workspaceRepairEvidence: "Verified fresh confined staging after repair." }),
    }));
  });
  it("starts with an empty form when the hold changes", async () => {
    await renderCancelledHold();
    await act(async () => buttonByText("Reconcile and continue").click());
    await fillValidForm(container.querySelector("form")!);
    await renderCancelledHold({}, "other-run");
    expect(container.querySelector("form")).toBeNull();
    await act(async () => buttonByText("Reconcile and continue").click());
    const form = container.querySelector("form")!;
    expect(form.querySelector("textarea")!.value).toBe("");
    expect(form.querySelector('[role="checkbox"]')!.getAttribute("aria-checked")).toBe("false");
    expect(form.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
  });
});
