import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker, ExecutionReconciliation } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Link } from "../lib/router";

const RECONCILABLE_RUN_STATUSES = ["failed", "timed_out", "interrupted", "cancelled"];
const MIN_OUTCOME_EVIDENCE_LENGTH = 20;
const ACTION_OUTCOME_OPTIONS: { value: ExecutionReconciliation["actionOutcome"]; label: string }[] = [
  { value: "not_performed", label: "No actions were performed" },
  { value: "completed", label: "All actions completed" },
  { value: "mixed", label: "Some actions completed" },
];

export function ExecutionBlockerNotice({ companyId, issueId, blocker, onRetried }: {
  companyId: string;
  issueId: string;
  blocker: ExecutionBlocker;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  const sourceRun = runs?.find(run => run.runId === blocker.runId);
  const failedRun = sourceRun && ["failed", "timed_out"].includes(sourceRun.status) ? sourceRun : undefined;
  const requiresInspection = blocker.cause === "native_continuation_requires_reconciliation" ||
    blocker.cause === "native_session_cleanup_quarantined";
  // A stopped legacy run, including one the board cancelled, can be cleared
  // only by recording what its actions did. Retry alone cannot clear it.
  const canReconcile = blocker.cause === "legacy_execution_requires_reconciliation" &&
    Boolean(blocker.recoveryActionId && blocker.runId) &&
    Boolean(sourceRun && RECONCILABLE_RUN_STATUSES.includes(sourceRun.status));
  const [reconciling, setReconciling] = useState(false);
  const [actionOutcome, setActionOutcome] = useState<ExecutionReconciliation["actionOutcome"] | null>(null);
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const [providerStopped, setProviderStopped] = useState(false);
  const refresh = () => {
    onRetried();
    for (const queryKey of [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
      queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId)]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(failedRun!.agentId, failedRun!.runId, companyId),
    onSuccess: refresh,
  });
  const reconcile = useMutation({
    mutationFn: () => issuesApi.resolveRecoveryAction(issueId, {
      actionId: blocker.recoveryActionId!,
      outcome: "restored",
      sourceIssueStatus: "todo",
      executionReconciliation: {
        runId: blocker.runId!,
        providerStopped: true,
        actionOutcome: actionOutcome!,
        outcomeEvidence: outcomeEvidence.trim(),
      },
    }),
    onSuccess: () => {
      setReconciling(false);
      refresh();
    },
  });
  const evidenceReady = outcomeEvidence.trim().length >= MIN_OUTCOME_EVIDENCE_LENGTH;
  const canSubmit = providerStopped && actionOutcome !== null && evidenceReady && !reconcile.isPending;
  return (
    <div role="status" aria-label="Task recovery" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
      <span>{blocker.cause === "legacy_execution_requires_reconciliation"
        ? "Automatic recovery of this task stopped."
        : `${requiresInspection ? "Recovery needed. " : ""}${blocker.nextAction}`}</span>
      {requiresInspection && blocker.agentId && blocker.runId && (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/agents/${blocker.agentId}/runs/${blocker.runId}`}>Inspect run</Link>
        </Button>
      )}
      {!reconciling && (!requiresInspection && failedRun || canReconcile) && (
        <div className="flex flex-wrap items-center gap-2">
          {!requiresInspection && failedRun && (
            <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
              {retry.isPending ? "Retrying…" : "Retry"}
            </Button>
          )}
          {canReconcile && (
            <Button variant="outline" size="sm" onClick={() => { reconcile.reset(); setReconciling(true); }}>
              Reconcile and continue
            </Button>
          )}
        </div>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
      {reconciling && (
        <form
          aria-label="Reconcile stopped run"
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => { event.preventDefault(); if (canSubmit) reconcile.mutate(); }}
        >
          <p className="text-muted-foreground">
            Record what the stopped run did. The task returns to To do and its agent continues from there. Actions are not repeated.
            {blocker.agentId && blocker.runId && (
              <> <Link className="underline" to={`/agents/${blocker.agentId}/runs/${blocker.runId}`}>Inspect run</Link></>
            )}
          </p>
          <fieldset className="flex flex-col gap-1">
            <legend className="font-medium">What did the run&apos;s actions do?</legend>
            {ACTION_OUTCOME_OPTIONS.map(option => (
              <label key={option.value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="execution-action-outcome"
                  value={option.value}
                  checked={actionOutcome === option.value}
                  onChange={() => setActionOutcome(option.value)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="font-medium">Evidence</span>
            <Textarea
              aria-label="Outcome evidence"
              value={outcomeEvidence}
              onChange={(event) => setOutcomeEvidence(event.target.value)}
              placeholder="What you checked, for example the run log or the external system."
            />
            {!evidenceReady && (
              <span className="text-muted-foreground">Write at least {MIN_OUTCOME_EVIDENCE_LENGTH} characters.</span>
            )}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={providerStopped} onChange={(event) => setProviderStopped(event.target.checked)} />
            The run&apos;s provider has stopped.
          </label>
          {reconcile.isError && (
            <p role="alert" className="text-destructive">{reconcile.error.message}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={reconcile.isPending} onClick={() => setReconciling(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {reconcile.isPending ? "Reconciling…" : "Reconcile and continue"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
