// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, it, expect, vi } from "vitest";
import { LocalClaudeLoginSource } from "./LocalClaudeLoginSource";
const props = { companyId:"company-fixture", agentId:"agent-fixture", adapterType:"claude_local", enabled:false, onChange:vi.fn() };
let root: Root;
afterEach(() => { if(root) flushSync(()=>root.unmount()); document.body.innerHTML=""; });
function render(change = {}) { const div=document.createElement("div");document.body.append(div);root=createRoot(div);flushSync(()=>root.render(<LocalClaudeLoginSource {...props} {...change}/>)); }
describe("local login source presentation", () => {
 it("requires explicit opt-in and distinguishes current checks from history", () => {
  render();const select = document.querySelector("select")!;expect(select.value).toBe("managed");
  flushSync(()=>{select.value="local";select.dispatchEvent(new Event("change",{bubbles:true}));});expect(props.onChange).toHaveBeenCalledWith(true);
  expect(document.body.textContent).toContain("historical failed runs remain unchanged");expect(document.body.textContent).not.toContain("Connected");
 });
 it.each([{companyId:""},{agentId:""},{adapterType:"codex_local"}])("hides outside admitted context %j", change => {render(change);expect(document.querySelector("select")).toBeNull();});
});
