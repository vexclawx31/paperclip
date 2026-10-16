import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageNativeRunnerAttachmentBytes } from "./native-runner-file-handoff.js";

// Scripted /usr/sbin/lsof outcomes. "real" runs the actual macOS lsof; every
// other execFile call (for example ps) always passes through.
type LsofStep =
  | { kind: "real" }
  | { kind: "timeout"; stdout?: string }
  | { kind: "error"; code: number | string | null; killed?: boolean; signal?: string | null }
  | { kind: "output"; stdout: string };

const control = vi.hoisted(() => ({
  steps: null as LsofStep[] | null,
  timeouts: [] as number[],
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const execFile = ((file: string, args: string[], options: { timeout?: number }, callback: (...result: unknown[]) => void) => {
    if (file !== "/usr/sbin/lsof" || !control.steps) {
      return (actual.execFile as unknown as (...input: unknown[]) => unknown)(file, args, options, callback);
    }
    control.timeouts.push(options.timeout ?? 0);
    const step = control.steps.shift() ?? { kind: "error", code: "unscripted" };
    if (step.kind === "real") {
      return (actual.execFile as unknown as (...input: unknown[]) => unknown)(file, args, options, callback);
    }
    setImmediate(() => {
      if (step.kind === "output") {
        callback(null, Buffer.from(step.stdout), Buffer.alloc(0));
        return;
      }
      // Shapes observed from Node's execFile on macOS: a timeout kill is
      // { code: null, killed: true, signal: "SIGTERM" } with no output.
      const error = Object.assign(new Error(`lsof ${step.kind}`), step.kind === "timeout"
        ? { code: null, killed: true, signal: "SIGTERM" }
        : { code: step.code, killed: step.killed ?? false, signal: step.signal ?? null });
      callback(error, Buffer.from(step.kind === "timeout" ? step.stdout ?? "" : ""), Buffer.alloc(0));
    });
    return undefined;
  }) as unknown as typeof actual.execFile;
  return { ...actual, execFile };
});

async function stage(steps: LsofStep[], workspaceRoot?: string) {
  const root = workspaceRoot ?? await mkdtemp(path.join(tmpdir(), "native-descriptor-check-"));
  control.steps = steps;
  control.timeouts = [];
  const result = stageNativeRunnerAttachmentBytes({ workspaceRoot: root, body: Buffer.from("staged bytes") });
  return { workspaceRoot: root, result };
}

function lsofCalls() {
  return control.timeouts.length;
}

afterEach(() => {
  control.steps = null;
});

describe.runIf(process.platform === "darwin")("macOS descriptor verification through lsof", () => {
  it("retries a timed-out lsof and verifies the same held descriptor with the real lsof", async () => {
    const { workspaceRoot, result } = await stage([{ kind: "timeout" }, { kind: "real" }]);
    const staged = await result;
    expect(await readFile(path.join(workspaceRoot, staged.workspaceRelativePath), "utf8")).toBe("staged bytes");
    expect(lsofCalls()).toBe(2);
    await staged.cleanup();
  });

  it("stays unverifiable after the bounded attempts all time out", async () => {
    const { result } = await stage([{ kind: "timeout" }, { kind: "timeout" }, { kind: "timeout" }, { kind: "real" }]);
    await expect(result).rejects.toThrow("paperclip_runner_file_handoff_descriptor_unverifiable");
    expect(lsofCalls()).toBe(3);
    expect(control.timeouts.every((timeout) => timeout > 0 && timeout <= 1_000)).toBe(true);
    expect(control.timeouts.reduce((sum, timeout) => sum + timeout, 0)).toBeLessThanOrEqual(3_000);
  });

  it.each([
    ["a non-zero lsof exit", { kind: "error", code: 1 }],
    ["an exceeded output buffer", { kind: "error", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM" }],
    ["a missing lsof binary", { kind: "error", code: "ENOENT" }],
    ["an externally signalled lsof", { kind: "error", code: null, killed: false, signal: "SIGTERM" }],
    ["a timeout that already produced output", { kind: "timeout", stdout: "p1\0" }],
  ] as const)("does not retry %s", async (_name, step) => {
    const { result } = await stage([step, { kind: "real" }]);
    await expect(result).rejects.toThrow("paperclip_runner_file_handoff_descriptor_unverifiable");
    expect(lsofCalls()).toBe(1);
  });

  it.each([
    ["no name field", "p1\0f3\0"],
    ["two name fields", "p1\0f3\0n/a\0n/b\0"],
    ["a relative name", "p1\0f3\0nrelative/file\0"],
  ])("denies malformed lsof output with %s", async (_name, stdout) => {
    const { result } = await stage([{ kind: "output", stdout }]);
    await expect(result).rejects.toThrow("paperclip_runner_file_handoff_descriptor_unverifiable");
    expect(lsofCalls()).toBe(1);
  });

  it("denies a descriptor that resolves to a different file, including after a retried timeout", async () => {
    for (const prefix of [[], [{ kind: "timeout" } as const]]) {
      for (const inside of [true, false]) {
        const workspaceRoot = await mkdtemp(path.join(tmpdir(), "native-descriptor-check-"));
        const otherDir = inside ? workspaceRoot : await mkdtemp(path.join(tmpdir(), "native-descriptor-other-"));
        const other = path.join(otherDir, "other.txt");
        await writeFile(other, "other bytes");
        const { result } = await stage([...prefix, { kind: "output", stdout: `p1\0f3\0n${other}\0` }], workspaceRoot);
        await expect(result).rejects.toThrow("paperclip_runner_attachment_staging_path_denied");
        expect(lsofCalls()).toBe(prefix.length + 1);
        expect(await readFile(other, "utf8")).toBe("other bytes");
      }
    }
  });
});
