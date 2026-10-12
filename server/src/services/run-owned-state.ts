import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * The run's task-tool capability (`contextSnapshot.paperclipTaskTools`) is
 * stamped transactionally by heartbeat delivery. Later whole-object
 * `contextSnapshot` writers (for example adapter-managed runtime-service
 * persistence) hold an in-memory copy without it. This expression keeps the
 * row's current marker inside the same UPDATE statement, so a stale copy can
 * neither erase nor replace it. Kept dependency-free to avoid import cycles.
 */
export const RUN_TASK_TOOL_CAPABILITY_KEY = "paperclipTaskTools";

/** Task-tool receipt identifiers shared with recovery (kept here to avoid cycles). */
export const TASK_TOOL_RECEIPT_DETAIL_KEY = "taskToolReceipt";
export const TASK_TOOL_STATUS_OPERATION = "update_task_status";
export const TASK_TOOL_STATUS_RECEIPT_ACTIONS = {
  pending: "issue.task_tool_status_requested",
  completed: "issue.task_tool_status_recorded",
  released: "issue.task_tool_status_released",
} as const;

export function preserveRunTaskToolCapabilitySql(next: Record<string, unknown> | null): SQL {
  const column = heartbeatRuns.contextSnapshot;
  const key = RUN_TASK_TOOL_CAPABILITY_KEY;
  if (next === null) {
    return sql`case when (${column} -> ${key}::text) is not null then jsonb_build_object(${key}::text, ${column} -> ${key}::text) else null end`;
  }
  // The row's current marker wins over any copy (or absence) in `next`.
  return sql`case when (${column} -> ${key}::text) is not null then ${JSON.stringify(next)}::jsonb || jsonb_build_object(${key}::text, ${column} -> ${key}::text) else ${JSON.stringify(next)}::jsonb end`;
}
