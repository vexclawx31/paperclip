import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker, ExecutionReconciliation } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { RadioCardGroup, type RadioCardOption } from "./ui/radio-card";
import { Textarea } from "./ui/textarea";
import { Link } from "../lib/router";

const RECONCILABLE_RUN_STATUSES = ["failed", "timed_out", "interrupted", "cancelled"];
const MIN_EVIDENCE_LENGTH = 20;
const ACTION_OUTCOME_OPTIONS: RadioCardOption[] = [
  { value: "not_performed", title: "No actions were performed" },
  { value: "completed", title: "All actions completed" },
  { value: "mixed", title: "Some actions completed" },
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
  const holdKey = `${blocker.recoveryActionId}:${blocker.runId}`;
  // The form belongs to one hold. A different hold never inherits it, and the
  // keyed form below starts with empty inputs.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const formOpen = openedFor === holdKey;
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
      {!formOpen && (!requiresInspection && failedRun || canReconcile) && (
        <div className="flex flex-wrap items-center gap-2">
          {!requiresInspection && failedRun && (
            <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
              {retry.isPending ? "Retrying…" : "Retry"}
            </Button>
          )}
          {canReconcile && (
            <Button variant="outline" size="sm" onClick={() => setOpenedFor(holdKey)}>
              Reconcile and continue
            </Button>
          )}
        </div>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
      {formOpen && (
        <ReconcileRunForm
          key={holdKey}
          issueId={issueId}
          blocker={blocker}
          onCancel={() => setOpenedFor(null)}
          onReconciled={() => { setOpenedFor(null); refresh(); }}
        />
      )}
    </div>
  );
}

function ReconcileRunForm({ issueId, blocker, onCancel, onReconciled }: {
  issueId: string;
  blocker: ExecutionBlocker;
  onCancel: () => void;
  onReconciled: () => void;
}) {
  const [actionOutcome, setActionOutcome] = useState<ExecutionReconciliation["actionOutcome"] | null>(null);
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const [workspaceRepairEvidence, setWorkspaceRepairEvidence] = useState("");
  const [providerStopped, setProviderStopped] = useState(false);
  const needsWorkspaceRepair = blocker.workspaceRepairRequired === true;
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
        ...(needsWorkspaceRepair ? { workspaceRepairEvidence: workspaceRepairEvidence.trim() } : {}),
      },
    }),
    onSuccess: onReconciled,
  });
  const evidenceReady = outcomeEvidence.trim().length >= MIN_EVIDENCE_LENGTH;
  const repairReady = !needsWorkspaceRepair || workspaceRepairEvidence.trim().length >= MIN_EVIDENCE_LENGTH;
  const canSubmit = providerStopped && actionOutcome !== null && evidenceReady && repairReady && !reconcile.isPending;
  return (
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
      <span className="font-medium">What did the run&apos;s actions do?</span>
      <RadioCardGroup
        ariaLabel="What did the run's actions do?"
        value={actionOutcome ?? ""}
        onValueChange={(value) => setActionOutcome(value as ExecutionReconciliation["actionOutcome"])}
        options={ACTION_OUTCOME_OPTIONS}
        disabled={reconcile.isPending}
      />
      <label className="flex flex-col gap-1">
        <span className="font-medium">Evidence</span>
        <Textarea
          aria-label="Outcome evidence"
          value={outcomeEvidence}
          onChange={(event) => setOutcomeEvidence(event.target.value)}
          placeholder="What you checked, for example the run log or the external system."
        />
        {!evidenceReady && (
          <span className="text-muted-foreground">Write at least {MIN_EVIDENCE_LENGTH} characters.</span>
        )}
      </label>
      {needsWorkspaceRepair && (
        <label className="flex flex-col gap-1">
          <span className="font-medium">Workspace repair</span>
          <Textarea
            aria-label="Workspace repair evidence"
            value={workspaceRepairEvidence}
            onChange={(event) => setWorkspaceRepairEvidence(event.target.value)}
            placeholder="How you verified safe workspace staging or repaired it."
          />
          {!repairReady && (
            <span className="text-muted-foreground">Write at least {MIN_EVIDENCE_LENGTH} characters.</span>
          )}
        </label>
      )}
      <label className="flex items-center gap-2">
        <Checkbox
          aria-label="The run's provider has stopped"
          checked={providerStopped}
          onCheckedChange={(checked) => setProviderStopped(checked === true)}
        />
        The run&apos;s provider has stopped.
      </label>
      {reconcile.isError && (
        <p role="alert" className="text-destructive">{reconcile.error.message}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={reconcile.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {reconcile.isPending ? "Reconciling…" : "Reconcile and continue"}
        </Button>
      </div>
    </form>
  );
}
