export function LocalClaudeLoginSource(props: { companyId: string; agentId: string; adapterType: string; enabled: boolean; onChange: (enabled: boolean) => void }) {
  if (!props.companyId || !props.agentId || props.adapterType !== "claude_local") return null;
  return <section aria-label="Claude authentication source" className="space-y-2">
    <label className="text-sm font-medium" htmlFor="local-claude-login-source">Claude authentication source</label>
    <select id="local-claude-login-source" aria-label="Claude authentication source" value={props.enabled ? "local" : "managed"}
      onChange={event => props.onChange(event.target.value === "local")}>
      <option value="managed">Managed responsible-user account</option>
      <option value="local">Local Claude Code login · operator-admitted host/user only</option>
    </select>
    <p className="text-xs text-muted-foreground">Native Claude owns sign-in and renewal. Test environment rechecks current usability after sign-in or refresh; historical failed runs remain unchanged. Saving requires a successful current provider check.</p>
  </section>;
}
