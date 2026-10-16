import path from "node:path";

// Fail-safe classifier for Hermes approval requests.
//
// A request is "yellow" (delegable) ONLY when the whole command parses and
// every simple command in it matches a known-safe category. Anything the
// parser cannot model (expansions, subshells, heredocs, inline interpreter
// code, shells, eval, xargs, unknown programs, paths it cannot place) is red.
//
// Paths: Hermes does not report the shell's working directory, and its
// terminal keeps the directory between tool calls. A relative path therefore
// has an unknown base unless the command itself first `cd`s into a configured
// safe root. File operations need a known base inside a safe root.

export type SafeCategory = "git" | "package_install" | "test_build_lint" | "workspace_files";

export type CommandAnalysis =
  | { safe: true; categories: SafeCategory[] }
  | { safe: false; reasons: string[] };

export const DEFAULT_SAFE_ROOTS = ["/tmp", "/private/tmp"];

type Word = { value: string; tilde: boolean };
type Token = { kind: "word"; word: Word } | { kind: "op"; value: string };
type Redirect = { op: string; target: Word | null };
type SimpleCommand = { words: Word[]; redirects: Redirect[] };
type Base = { kind: "unknown" } | { kind: "outside" } | { kind: "inside"; root: string; abs: string };
type Place = { kind: "unknown" } | { kind: "outside" } | { kind: "inside"; isRoot: boolean };

class Unsafe extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const fail = (reason: string): never => {
  throw new Unsafe(reason);
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let value = "";
  let inWord = false;
  let tilde = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", word: { value, tilde } });
    value = "";
    inWord = false;
    tilde = false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      flush();
      tokens.push({ kind: "op", value: ";" });
      continue;
    }
    if (ch === "\\") {
      if (next === undefined) fail("unparseable");
      if (next === "\n") {
        i += 1;
        continue;
      }
      value += next;
      inWord = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) fail("unparseable");
      value += input.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < input.length && input[j] !== '"'; j += 1) {
        const c = input[j]!;
        if (c === "$" || c === "`") fail("shell_expansion");
        if (c === "\\" && j + 1 < input.length) {
          value += input[j + 1];
          j += 1;
          continue;
        }
        value += c;
      }
      if (j >= input.length) fail("unparseable");
      inWord = true;
      i = j;
      continue;
    }
    if (ch === "$" || ch === "`") fail("shell_expansion");
    if (ch === "(" || ch === ")") fail("subshell");
    if (ch === "#" && !inWord) fail("unparseable");
    if (ch === "~" && !inWord) tilde = true;
    if (ch === ";") {
      flush();
      tokens.push({ kind: "op", value: ";" });
      continue;
    }
    if (ch === "&") {
      flush();
      if (next === "&") {
        tokens.push({ kind: "op", value: "&&" });
        i += 1;
        continue;
      }
      if (next === ">") fail("unparseable");
      fail("background_job");
    }
    if (ch === "|") {
      flush();
      if (next === "|") {
        tokens.push({ kind: "op", value: "||" });
        i += 1;
        continue;
      }
      if (next === "&") fail("unparseable");
      tokens.push({ kind: "op", value: "|" });
      continue;
    }
    if (ch === ">" || ch === "<") {
      // A bare fd number directly before the operator belongs to it.
      if (inWord && /^\d+$/.test(value) && !tilde) {
        value = "";
        inWord = false;
      } else {
        flush();
      }
      if (ch === "<" && next === "<") fail("heredoc");
      if (next === "(") fail("process_substitution");
      let op = ch;
      if (ch === ">" && next === ">") {
        op = ">>";
        i += 1;
      }
      if (input[i + 1] === "&") {
        const dup = /^&(\d+|-)/.exec(input.slice(i + 1));
        if (!dup) fail("unparseable");
        tokens.push({ kind: "op", value: "dup" });
        i += dup![0].length;
        continue;
      }
      tokens.push({ kind: "op", value: op });
      continue;
    }
    value += ch;
    inWord = true;
  }
  flush();
  return tokens;
}

type Pipeline = SimpleCommand[];

function parse(input: string): Pipeline[] {
  const tokens = tokenize(input);
  const pipelines: Pipeline[] = [];
  let pipeline: Pipeline = [];
  let current: SimpleCommand = { words: [], redirects: [] };
  const endCommand = () => {
    if (current.words.length === 0) {
      if (current.redirects.length > 0) fail("unparseable");
      return false;
    }
    pipeline.push(current);
    current = { words: [], redirects: [] };
    return true;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "word") {
      current.words.push(token.word);
      continue;
    }
    if (token.value === "dup") {
      current.redirects.push({ op: "dup", target: null });
      continue;
    }
    if (token.value === ">" || token.value === ">>" || token.value === "<") {
      const target = tokens[i + 1];
      if (!target || target.kind !== "word") fail("unparseable");
      current.redirects.push({ op: token.value, target: (target as { word: Word }).word });
      i += 1;
      continue;
    }
    if (token.value === "|") {
      if (!endCommand()) fail("unparseable");
      continue;
    }
    // && || ;
    const had = endCommand();
    if (!had && pipeline.length === 0) {
      if (token.value === ";") continue;
      fail("unparseable");
    }
    if (pipeline.length > 0) pipelines.push(pipeline);
    pipeline = [];
  }
  endCommand();
  if (pipeline.length > 0) pipelines.push(pipeline);
  if (pipelines.length === 0) fail("unclassifiable");
  return pipelines;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots
    .map((root) => root.trim())
    .filter((root) => root.startsWith("/"))
    .map((root) => path.posix.normalize(root).replace(/\/+$/, ""))
    .filter((root) => root.length > 1))];
}

function placeAbsolute(abs: string, roots: string[]): { root: string; isRoot: boolean } | null {
  const normalized = path.posix.normalize(abs).replace(/\/+$/, "") || "/";
  for (const root of roots) {
    if (normalized === root) return { root, isRoot: true };
    if (normalized.startsWith(`${root}/`)) return { root, isRoot: false };
  }
  return null;
}

class Analyzer {
  base: Base = { kind: "unknown" };
  categories = new Set<SafeCategory>();

  constructor(readonly roots: string[]) {}

  resolveAbs(word: Word): string | "outside" | "unknown" {
    if (word.tilde || word.value.startsWith("~")) return "outside";
    if (word.value.startsWith("/")) return path.posix.normalize(word.value);
    if (this.base.kind === "outside") return "outside";
    if (this.base.kind === "unknown") return "unknown";
    return path.posix.normalize(path.posix.join(this.base.abs, word.value));
  }

  place(word: Word): Place {
    const resolved = this.resolveAbs(word);
    if (resolved === "outside") return { kind: "outside" };
    if (resolved === "unknown") {
      // `..` can climb out of whatever the base is.
      return word.value.split("/").includes("..") ? { kind: "outside" } : { kind: "unknown" };
    }
    const placed = placeAbsolute(resolved, this.roots);
    return placed ? { kind: "inside", isRoot: placed.isRoot } : { kind: "outside" };
  }

  /** A path the command reads or writes; deletes/moves also forbid the root itself. */
  requirePath(word: Word, mode: "read" | "write" | "destroy"): void {
    if (mode !== "destroy" && word.value === "/dev/null") return;
    const placed = this.place(word);
    if (placed.kind === "outside") fail(mode === "destroy" ? "delete_outside_workspace" : "path_outside_workspace");
    if (placed.kind === "unknown") fail("unknown_base_directory");
    if (mode === "destroy" && placed.kind === "inside" && placed.isRoot) fail("delete_outside_workspace");
  }

  /** Arguments of build/test tools: only explicit absolute, home or `..` paths are checked. */
  requireArgsStayInside(args: Word[]): void {
    for (const arg of args) {
      const value = arg.value.includes("=") && arg.value.startsWith("-") ? arg.value.slice(arg.value.indexOf("=") + 1) : arg.value;
      if (arg.tilde || value.startsWith("~") || value.startsWith("/") || value.split("/").includes("..")) {
        this.requirePath({ value, tilde: arg.tilde }, "read");
      }
    }
  }

  cd(args: Word[]): void {
    if (args.length !== 1 || args[0]!.value === "-") {
      this.base = { kind: "outside" };
      return;
    }
    const resolved = this.resolveAbs(args[0]!);
    if (resolved === "outside") {
      this.base = { kind: "outside" };
      return;
    }
    if (resolved === "unknown") {
      if (args[0]!.value.split("/").includes("..")) this.base = { kind: "outside" };
      return;
    }
    const placed = placeAbsolute(resolved, this.roots);
    this.base = placed ? { kind: "inside", root: placed.root, abs: resolved } : { kind: "outside" };
  }

  run(pipelines: Pipeline[]): void {
    for (const pipeline of pipelines) {
      if (this.base.kind === "outside") fail("cd_outside_workspace");
      for (const command of pipeline) {
        if (this.base.kind === "outside") fail("cd_outside_workspace");
        this.simple(command, pipeline.length > 1);
      }
    }
  }

  simple(command: SimpleCommand, inPipeline: boolean): void {
    let words = [...command.words];
    // Normalise: leading env assignments and transparent prefixes.
    while (words.length > 0) {
      const head = words[0]!.value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
        const key = head.slice(0, head.indexOf("="));
        if (!SAFE_ENV_ASSIGNMENTS.has(key)) fail("env_assignment");
        words = words.slice(1);
        continue;
      }
      if (head === "command" || head === "builtin") {
        words = words.slice(1);
        if (words[0]?.value.startsWith("-")) fail("unparseable");
        continue;
      }
      if (head === "env") {
        words = words.slice(1);
        if (words[0]?.value.startsWith("-")) fail("env_assignment");
        continue;
      }
      break;
    }
    if (words.length === 0) fail("unclassifiable");
    for (const redirect of command.redirects) {
      if (redirect.op === "dup") continue;
      this.requirePath(redirect.target!, redirect.op === "<" ? "read" : "write");
      if (redirect.op !== "<" && redirect.target!.value !== "/dev/null") this.categories.add("workspace_files");
    }
    const program = path.posix.basename(words[0]!.value);
    if (words[0]!.value.includes("/")) fail("unknown_command");
    const args = words.slice(1);
    if (program === "cd") {
      if (inPipeline) fail("unparseable");
      this.cd(args);
      return;
    }
    const handler = HANDLERS[program];
    if (!handler) fail(RED_PROGRAM_REASONS[program] ?? "unknown_command");
    handler!(this, args);
  }
}

const SAFE_ENV_ASSIGNMENTS = new Set(["CI", "NODE_ENV", "FORCE_COLOR", "NO_COLOR", "DEBUG", "TZ", "LANG", "LC_ALL"]);

const RED_PROGRAM_REASONS: Record<string, string> = {
  sh: "shell_exec", bash: "shell_exec", zsh: "shell_exec", dash: "shell_exec", ksh: "shell_exec", fish: "shell_exec",
  eval: "eval", exec: "eval", source: "eval", ".": "eval",
  xargs: "xargs",
  base64: "decode_pipe", xxd: "decode_pipe", openssl: "decode_pipe",
  sudo: "privilege", doas: "privilege", su: "privilege",
  curl: "network", wget: "network", ssh: "network", scp: "network", rsync: "network", nc: "network",
  python: "interpreter", python3: "interpreter", node: "interpreter", deno: "interpreter", ruby: "interpreter",
  perl: "interpreter", php: "interpreter", osascript: "interpreter",
  awk: "interpreter", gawk: "interpreter",
};

type Handler = (analyzer: Analyzer, args: Word[]) => void;

const flagsOf = (args: Word[]) => args.filter((arg) => arg.value.startsWith("-"));
const positional = (args: Word[]) => args.filter((arg) => !arg.value.startsWith("-"));

// --- git --------------------------------------------------------------------

const GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "describe", "blame", "shortlog", "ls-files", "grep", "fetch",
  "add", "commit", "checkout", "switch", "restore", "reset", "stash", "merge", "rebase", "cherry-pick", "revert",
  "tag", "pull", "clean", "mv", "rm", "branch", "push", "remote",
]);
const GIT_PUSH_FLAGS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--dry-run", "-n", "--follow-tags"]);

function protectedRef(ref: string): boolean {
  const destination = ref.replace(/^\+/, "").split(":").pop() ?? "";
  const name = destination.replace(/^refs\/heads\//, "");
  return name === "main" || name === "master" || name === "HEAD" || name === "";
}

function gitHandler(analyzer: Analyzer, args: Word[]): void {
  let rest = args;
  while (rest[0]?.value.startsWith("-")) {
    const flag = rest[0]!.value;
    if (flag === "--no-pager") {
      rest = rest.slice(1);
      continue;
    }
    fail("git_unsafe_option");
  }
  const sub = rest[0]?.value;
  if (!sub || !GIT_SUBCOMMANDS.has(sub)) fail("git_unsafe_subcommand");
  const subArgs = rest.slice(1);
  // Git refuses relative pathspecs outside the repository; explicit
  // absolute or home paths must still sit inside a safe root.
  for (const arg of subArgs) {
    if (arg.tilde || arg.value.startsWith("/") || arg.value.startsWith("~")) analyzer.requirePath(arg, "read");
  }
  if (sub === "remote") {
    const values = subArgs.map((arg) => arg.value);
    const readOnly =
      values.length === 0 ||
      (values.length === 1 && (values[0] === "-v" || values[0] === "--verbose")) ||
      (values.length === 2 && (values[0] === "get-url" || values[0] === "show"));
    if (!readOnly) fail("git_unsafe_subcommand");
  }
  if (sub === "push") {
    let force = false;
    for (const flag of flagsOf(subArgs)) {
      const value = flag.value;
      if (value === "-f" || value === "--force" || value.startsWith("--force-with-lease") || value === "--force-if-includes") {
        force = true;
        continue;
      }
      if (value === "--delete" || value === "-d") fail("remote_branch_delete");
      if (!GIT_PUSH_FLAGS.has(value)) fail("git_unsafe_option");
    }
    const refs = positional(subArgs).map((word) => word.value);
    if (refs.slice(1).some((ref) => ref.startsWith(":"))) fail("remote_branch_delete");
    if (refs.slice(1).some((ref) => ref.startsWith("+"))) force = true;
    if (force) {
      if (refs.length < 2) fail("force_push_protected");
      if (refs.slice(1).some(protectedRef)) fail("force_push_protected");
    }
  }
  analyzer.categories.add("git");
}

// --- package managers, tests, builds ----------------------------------------

const SAFE_SCRIPT = /^(test|build|lint|typecheck|type-check|check|format|fmt|vitest|tsc|e2e)(:[\w:.-]+)?$/;
const SAFE_TOOLS = new Set(["vitest", "jest", "tsc", "eslint", "prettier", "biome", "oxlint", "mocha", "ava", "c8", "nyc", "playwright"]);
const INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "remove", "rm", "uninstall", "un", "update", "up"]);
const TEST_SUBCOMMANDS = new Set(["test", "t", "build", "lint", "typecheck", "check", "format"]);

function installSpecs(analyzer: Analyzer, args: Word[]): void {
  for (const flag of flagsOf(args)) {
    if (/^(-g|--global|--location=global|--registry.*|--prefix.*)$/.test(flag.value)) fail("global_or_remote_install");
  }
  for (const spec of positional(args)) {
    if (/^(file:|link:|git\+|https?:|\/|~|\.\.)/.test(spec.value) || spec.value.includes("://")) fail("install_source_outside_registry");
  }
  analyzer.requireArgsStayInside(args);
  analyzer.categories.add("package_install");
}

function toolRun(analyzer: Analyzer, tool: string | undefined, args: Word[]): void {
  if (!tool || !SAFE_TOOLS.has(tool)) fail("unknown_command");
  analyzer.requireArgsStayInside(args);
  analyzer.categories.add("test_build_lint");
}

function jsPackageManager(analyzer: Analyzer, args: Word[]): void {
  let rest = args;
  // Workspace-selection options only.
  while (rest[0]?.value.startsWith("-")) {
    const flag = rest[0]!.value;
    if (["-w", "--workspace-root", "-r", "--recursive", "-s", "--silent"].includes(flag)) {
      rest = rest.slice(1);
      continue;
    }
    if ((flag === "--filter" || flag === "-F") && rest[1]) {
      rest = rest.slice(2);
      continue;
    }
    if (flag.startsWith("--filter=")) {
      rest = rest.slice(1);
      continue;
    }
    fail("package_manager_unsafe_option");
  }
  const sub = rest[0]?.value;
  const subArgs = rest.slice(1);
  if (!sub) fail("unknown_command");
  if (INSTALL_SUBCOMMANDS.has(sub!)) return installSpecs(analyzer, subArgs);
  if (TEST_SUBCOMMANDS.has(sub!) || SAFE_SCRIPT.test(sub!)) {
    analyzer.requireArgsStayInside(subArgs);
    analyzer.categories.add("test_build_lint");
    return;
  }
  if (sub === "run" || sub === "run-script") {
    if (!subArgs[0] || !SAFE_SCRIPT.test(subArgs[0].value)) fail("unknown_script");
    analyzer.requireArgsStayInside(subArgs.slice(1));
    analyzer.categories.add("test_build_lint");
    return;
  }
  if (sub === "exec" || sub === "dlx" || sub === "x") return toolRun(analyzer, subArgs[0]?.value, subArgs.slice(1));
  fail("unknown_command");
}

function pythonModule(analyzer: Analyzer, args: Word[]): void {
  // python -m <safe module>; any other python use is red (interpreter).
  if (args[0]?.value !== "-m") fail("interpreter");
  const module = args[1]?.value;
  const rest = args.slice(2);
  if (module === "pytest" || module === "mypy" || module === "ruff" || module === "black") {
    analyzer.requireArgsStayInside(rest);
    analyzer.categories.add("test_build_lint");
    return;
  }
  if (module === "pip") return pipHandler(analyzer, rest);
  fail("interpreter");
}

function pipHandler(analyzer: Analyzer, args: Word[]): void {
  if (args[0]?.value !== "install") fail("unknown_command");
  const rest = args.slice(1);
  // Only requirement files or editable installs of a workspace path.
  const values = rest.map((arg) => arg.value);
  const ok = (values[0] === "-r" || values[0] === "-e") && values.length === 2;
  if (!ok) fail("global_or_remote_install");
  analyzer.requirePath(rest[1]!, "read");
  analyzer.categories.add("package_install");
}

function subcommandTool(allowed: Record<string, SafeCategory>): Handler {
  return (analyzer, args) => {
    const sub = args[0]?.value;
    const key = sub && args[1] && allowed[`${sub} ${args[1].value}`] ? `${sub} ${args[1].value}` : sub;
    const category = key ? allowed[key] : undefined;
    if (!category) fail("unknown_command");
    analyzer.requireArgsStayInside(args.slice(1));
    analyzer.categories.add(category!);
  };
}

function bareTool(category: SafeCategory): Handler {
  return (analyzer, args) => {
    analyzer.requireArgsStayInside(args);
    analyzer.categories.add(category);
  };
}

function makeHandler(analyzer: Analyzer, args: Word[]): void {
  for (const arg of args) {
    if (arg.value.startsWith("-") || arg.value.includes("=") || !SAFE_SCRIPT.test(arg.value)) fail("unknown_script");
  }
  analyzer.categories.add("test_build_lint");
}

// --- workspace files --------------------------------------------------------

function readFiles(patternFirst = false): Handler {
  return (analyzer, args) => {
    let usesPatternFlag = false;
    if (patternFirst) {
      // grep -f/--file reads patterns from a file the classifier would have to place.
      if (args.some((arg) => arg.value === "-f" || arg.value.startsWith("--file"))) fail("unparseable");
      usesPatternFlag = args.some((arg) => arg.value === "-e" || arg.value.startsWith("--regexp"));
    }
    // Pure numbers are option values such as `head -n 20`, never paths.
    const paths = positional(args).filter((word) => !/^\d+$/.test(word.value));
    for (const [index, word] of paths.entries()) {
      if (patternFirst && !usesPatternFlag && index === 0) continue;
      analyzer.requirePath(word, "read");
    }
    analyzer.requireArgsStayInside(flagsOf(args));
    analyzer.categories.add("workspace_files");
  };
}

const textOnly: Handler = (analyzer) => {
  analyzer.categories.add("workspace_files");
};

function writeFiles(mode: "write" | "destroy", skipFirst = false): Handler {
  return (analyzer, args) => {
    const paths = positional(args);
    if (paths.length === 0) fail("unclassifiable");
    for (const [index, word] of paths.entries()) {
      if (skipFirst && index === 0) continue;
      analyzer.requirePath(word, mode);
    }
    analyzer.categories.add("workspace_files");
  };
}

const FIND_PREDICATES = new Set([
  "-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-print", "-print0", "-size", "-mtime",
  "-mmin", "-newer", "-not", "!", "-o", "-a", "-and", "-or", "-empty", "-regex", "-iregex", "(", ")",
]);
const FIND_VALUE_PREDICATES = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-newer", "-regex", "-iregex"]);

const findHandler: Handler = (analyzer, args) => {
  let index = 0;
  const roots: Word[] = [];
  while (index < args.length && !args[index]!.value.startsWith("-") && !["!", "("].includes(args[index]!.value)) {
    roots.push(args[index]!);
    index += 1;
  }
  if (roots.length === 0) fail("unknown_base_directory");
  for (const root of roots) analyzer.requirePath(root, "read");
  for (; index < args.length; index += 1) {
    const predicate = args[index]!.value;
    if (["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(predicate)) fail("find_exec_or_delete");
    if (!FIND_PREDICATES.has(predicate)) fail("find_unsafe_predicate");
    if (FIND_VALUE_PREDICATES.has(predicate)) index += 1;
  }
  analyzer.categories.add("workspace_files");
};

const SAFE_SED_SCRIPT = /^(\d+(,\d+)?p|\$p|s(.)(?:(?!\3).)*\3(?:(?!\3).)*\3[gip0-9]*)$/;

const sedHandler: Handler = (analyzer, args) => {
  const scripts: string[] = [];
  const files: Word[] = [];
  let inPlace = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!.value;
    if (value === "-n" || value === "-E" || value === "-r") continue;
    if (value === "-i" || value.startsWith("-i")) {
      inPlace = true;
      // BSD sed takes a separate (possibly empty) suffix argument.
      if (value === "-i" && args[index + 1]?.value === "") index += 1;
      continue;
    }
    if (value === "-e") {
      const script = args[index + 1]?.value;
      if (script === undefined) fail("unparseable");
      scripts.push(script!);
      index += 1;
      continue;
    }
    if (value.startsWith("-")) fail("unknown_command");
    if (scripts.length === 0) scripts.push(value);
    else files.push(args[index]!);
  }
  if (scripts.length === 0 || scripts.some((script) => !SAFE_SED_SCRIPT.test(script))) fail("sed_unsafe_script");
  for (const file of files) analyzer.requirePath(file, inPlace ? "write" : "read");
  analyzer.categories.add("workspace_files");
};

const chmodHandler: Handler = (analyzer, args) => {
  const [mode, ...paths] = positional(args);
  if (!mode || !/^([0-7]{3,4}|[ugoa]*[-+=][rwxX]+)$/.test(mode.value) || /7$|o\+w|a\+w/.test(mode.value)) fail("privilege");
  if (paths.length === 0) fail("unclassifiable");
  for (const word of paths) analyzer.requirePath(word, "write");
  analyzer.categories.add("workspace_files");
};

const HANDLERS: Record<string, Handler> = {
  git: gitHandler,
  pnpm: jsPackageManager,
  npm: jsPackageManager,
  yarn: jsPackageManager,
  bun: jsPackageManager,
  npx: (analyzer, args) => toolRun(analyzer, args[0]?.value, args.slice(1)),
  pip: pipHandler,
  pip3: pipHandler,
  uv: subcommandTool({ sync: "package_install", add: "package_install", remove: "package_install", lock: "package_install" }),
  poetry: subcommandTool({ install: "package_install", add: "package_install", remove: "package_install", lock: "package_install" }),
  cargo: subcommandTool({ test: "test_build_lint", build: "test_build_lint", check: "test_build_lint", clippy: "test_build_lint", fmt: "test_build_lint", fetch: "package_install", add: "package_install" }),
  go: subcommandTool({ test: "test_build_lint", build: "test_build_lint", vet: "test_build_lint", fmt: "test_build_lint", "mod download": "package_install", "mod tidy": "package_install" }),
  make: makeHandler,
  vitest: bareTool("test_build_lint"),
  jest: bareTool("test_build_lint"),
  tsc: bareTool("test_build_lint"),
  eslint: bareTool("test_build_lint"),
  prettier: bareTool("test_build_lint"),
  pytest: bareTool("test_build_lint"),
  ruff: bareTool("test_build_lint"),
  mypy: bareTool("test_build_lint"),
  python: pythonModule,
  python3: pythonModule,
  cat: readFiles(),
  head: readFiles(),
  tail: readFiles(),
  wc: readFiles(),
  ls: readFiles(),
  stat: readFiles(),
  file: readFiles(),
  du: readFiles(),
  diff: readFiles(),
  sort: readFiles(),
  uniq: readFiles(),
  cut: readFiles(),
  grep: readFiles(true),
  egrep: readFiles(true),
  fgrep: readFiles(true),
  rg: readFiles(true),
  jq: readFiles(true),
  find: findHandler,
  sed: sedHandler,
  echo: textOnly,
  printf: textOnly,
  pwd: textOnly,
  true: textOnly,
  tr: textOnly,
  mkdir: writeFiles("write"),
  touch: writeFiles("write"),
  tee: writeFiles("write"),
  cp: writeFiles("write"),
  ln: writeFiles("write"),
  mv: writeFiles("destroy"),
  rm: writeFiles("destroy"),
  rmdir: writeFiles("destroy"),
  unlink: writeFiles("destroy"),
  chmod: chmodHandler,
};

/** Analyse a whole command against the known-safe categories. */
export function analyzeCommand(command: string, safeRoots: string[] = DEFAULT_SAFE_ROOTS): CommandAnalysis {
  try {
    const pipelines = parse(command);
    const analyzer = new Analyzer(normalizeRoots(safeRoots));
    analyzer.run(pipelines);
    const categories = [...analyzer.categories].sort();
    if (categories.length === 0) return { safe: false, reasons: ["unclassifiable"] };
    return { safe: true, categories };
  } catch (err) {
    if (err instanceof Unsafe) return { safe: false, reasons: [err.reason] };
    return { safe: false, reasons: ["classifier_error"] };
  }
}

export function readSafeRoots(value: unknown): string[] {
  const configured = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  return normalizeRoots([...DEFAULT_SAFE_ROOTS, ...configured]);
}
