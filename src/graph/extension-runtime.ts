import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";

export interface ExtensionExecutionInput {
  repoRoot: string;
  entry: string;
  files: Array<{ path: string; content: string }>;
  index: Record<string, Array<{ id: string; name: string; kind: string; startLine: number; endLine: number }>>;
  config: unknown;
  excludePaths?: string[];
}

export const EXECUTION_REASON_CODES = ["invalid-input", "context-too-large", "isolation-unavailable", "timeout", "source-limit", "output-rejected", "extension-error", "runtime-error"] as const;
export type ExtensionExecutionReasonCode = typeof EXECUTION_REASON_CODES[number];
class RuntimeFailure extends Error {
  constructor(readonly reasonCode: ExtensionExecutionReasonCode, message: string) { super(message); }
}

export interface ExtensionExecution {
  status: "ok" | "failed" | "skipped";
  reason?: string;
  reasonCode?: ExtensionExecutionReasonCode;
  /** Host digest of the actual source snapshot; unavailable means capture failed. */
  inputFingerprint?: string;
  nodes?: unknown;
  edges?: unknown;
  log: string[];
  durationMs: number;
}

// A source view that completed within execution's budget must also be eligible
// for freshness comparison; a shorter comparison cap causes endless rebuilds.
export const EXTENSION_MAX_DURATION_MS = 15_000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const SOURCE_LIMIT = 256 * 1024 * 1024;
const SOURCE_FILE_LIMIT = 50_000;
const PRUNED = new Set(["node_modules", "graft", "vendor", "tmp", "log", "coverage", "dist", "build"]);
const SECRET_FILE = /(?:\.(?:pem|key|p12|pfx)$|^(?:credentials|secrets)(?:\.|$))/i;

/** Diagnostics are untrusted input to a terminal, even after OS containment. */
export function extensionDisplayText(value: unknown, max = 1024): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").slice(0, max);
}

/** Preserve JSON values while escaping characters JSON.stringify leaves literal. */
export function extensionDisplayJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The host must use the same source view when validating contributed spans. */
export function extensionSourcePath(path: string): boolean {
  return packagePath(path) && path.split("/").every(part => !part.startsWith(".") && !PRUNED.has(part) && !SECRET_FILE.test(part));
}

function packagePath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && !path.includes("\\") && !path.includes("\0")
    && !posix.isAbsolute(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

interface ProcessResult { stdout: Buffer; stderr: Buffer; reason?: string; reasonCode?: ExtensionExecutionReasonCode; code: number | null }

// SIGTERM is advisory: an extension can install a handler and keep the build
// alive forever. Kill the detached supervisor group with SIGKILL; Bubblewrap's
// parent-death signal also kills its namespace init, which reaps descendants
// even if they opened a new session of their own.
function run(command: string, args: string[], input: string, timeoutMs: number, maxOutputBytes: number): Promise<ProcessResult> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, args, { env: {}, stdio: ["pipe", "pipe", "pipe"], detached: true }); }
    catch { resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), reason: "sandbox process could not start", reasonCode: "runtime-error", code: null }); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, reason: string | undefined;
    let settled = false, reasonCode: ExtensionExecutionReasonCode | undefined;
    const stop = (why: string, code: ExtensionExecutionReasonCode = "runtime-error") => {
      if (!reason) { reason = why; reasonCode = code; }
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => stop("extension timeout exceeded", "timeout"), timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), reason, reasonCode, code });
    };
    child.once("error", () => { reason ??= "sandbox process could not start"; reasonCode ??= "runtime-error"; finish(null); });
    child.once("close", finish);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) { stop("extension stdout byte limit exceeded", "output-rejected"); return; }
      stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_LIMIT) { stop("extension stderr byte limit exceeded", "output-rejected"); return; }
      stderr.push(chunk);
    });
    child.stdin!.on("error", () => { stop("extension input pipe failed"); });
    child.stdout!.on("error", () => stop("extension output pipe failed"));
    child.stderr!.on("error", () => stop("extension error pipe failed"));
    child.stdin!.end(input);
  });
}

function sandboxArgs(node: string, snapshot?: string): string[] {
  const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
    "--new-session", "--die-with-parent", "--cap-drop", "ALL", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
    "--ro-bind", node, "/node", "--proc", "/proc"];
  if (snapshot) args.push("--ro-bind", join(snapshot, "repo"), "/repo", "--ro-bind", join(snapshot, "package"), "/package",
    "--ro-bind", join(snapshot, "runtime"), "/runtime", "--chdir", "/package");
  args.push("--remount-ro", "/", "--", "/node", "--permission", "--disable-wasm-trap-handler", "--max-old-space-size=256");
  return args;
}

let support: Promise<{ node?: string; reason?: string }> | undefined;
async function isolationSupport(): Promise<{ node?: string; reason?: string }> {
  if (process.platform !== "linux") return { reason: "extension isolation requires Linux and Bubblewrap" };
  if (Number(process.versions.node.split(".")[0]) < 24) return { reason: "extension isolation requires Node 24 or newer" };
  support ??= (async () => {
    try {
      await Promise.all([access("/usr/bin/bwrap", constants.X_OK), access("/usr/bin/prlimit", constants.X_OK)]);
      const node = await realpath(process.execPath);
      const result = await run("/usr/bin/prlimit", ["--as=4294967296", "--cpu=3", "--nofile=128", "--core=0", "--",
        "/usr/bin/bwrap", ...sandboxArgs(node), "-e", 'process.stdout.write(typeof require("node:module").registerHooks)'], "", 3000, 1024);
      if (result.reason || result.code !== 0 || result.stdout.toString("utf8") !== "function") {
        return { reason: "required Bubblewrap namespaces, Node permissions, or resource limits are unavailable" };
      }
      return { node };
    } catch { return { reason: "required Bubblewrap or prlimit executable is unavailable" }; }
  })();
  const pending = support;
  const result = await pending;
  // A failed probe used to survive for the lifetime of an MCP process, so a
  // later graph retry could never recover after the host restored isolation.
  // Share an in-flight probe, but never memoize its failure indefinitely.
  if (!result.node && support === pending) support = undefined;
  return result;
}

/** A custom context directory must not become an input to its own next build.
 * Cover both the lexical location and an existing symlink's canonical target. */
export function extensionOutputExclusions(root: string, outputDir: string): string[] {
  const canonical = (path: string): string => {
    try { return realpathSync(path); }
    catch {
      const parent = dirname(path);
      return parent === path ? path : join(canonical(parent), basename(path));
    }
  };
  const lexicalRoot = resolve(root), canonicalRoot = canonical(lexicalRoot), output = resolve(outputDir);
  const exclusions = new Set<string>();
  for (const [base, path] of [[lexicalRoot, output], [canonicalRoot, output], [canonicalRoot, canonical(output)]]) {
    if (path === base) exclusions.add(".");
    else if (path.startsWith(base + sep)) exclusions.add(relative(base, path).split(sep).join("/"));
  }
  return [...exclusions].sort();
}

const validExclusions = (paths: unknown): paths is string[] => Array.isArray(paths) && paths.length <= 64
  && paths.every(path => typeof path === "string" && path.length <= 4096 && (path === "." || packagePath(path)));
const excludedSource = (path: string, exclusions: string[]): boolean => exclusions.some(exclusion => exclusion === "." || path === exclusion || path.startsWith(exclusion + "/"));

const sourceDigest = (records: string[]): string => createHash("sha256").update(records.sort().join("\n")).digest("hex");
// Retain fixed-size leaf hashes, not every full path: a deep tree can otherwise
// amplify the bounded entry count into a large collection of repeated prefixes.
const directoryRecord = (path: string): string => createHash("sha256").update(JSON.stringify(["directory", path])).digest("hex");
const fileRecord = (path: string, digest: string): string => createHash("sha256").update(JSON.stringify(["file", path, digest])).digest("hex");

/** Read-only equivalent of the isolated source view, including empty directories.
 * Always hash bytes: non-source inputs and same-stat edits affect extension edges
 * just as source edits do. No extension code or reported dependency list is used. */
export function extensionInputFingerprint(root: string, excludePaths: string[] = []): string | null {
  if (!validExclusions(excludePaths) || process.platform !== "linux") return null;
  const deadline = performance.now() + EXTENSION_MAX_DURATION_MS, records: string[] = [];
  let bytes = 0, entries = 0;
  const check = () => { if (performance.now() >= deadline) throw new Error("source fingerprint time limit exceeded"); };
  const walk = (source: string, relative: string, depth: number): void => {
    check();
    if (depth > 64) throw new Error("source fingerprint depth limit exceeded");
    const fd = openSync(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const anchor = `/proc/self/fd/${fd}`, listing = opendirSync(anchor);
      records.push(directoryRecord(relative));
      try { for (let entry; (entry = listing.readSync());) {
        check();
        if (++entries > SOURCE_FILE_LIMIT) throw new Error("source fingerprint entry limit exceeded");
        if (!extensionSourcePath(entry.name) || entry.isSymbolicLink()) continue;
        const from = `${anchor}/${entry.name}`, path = relative ? `${relative}/${entry.name}` : entry.name;
        if (excludedSource(path, excludePaths)) continue;
        const known = entry.isDirectory() || entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket();
        const metadata = known ? entry : lstatSync(from);
        if (metadata.isDirectory()) { walk(from, path, depth + 1); continue; }
        if (!metadata.isFile()) continue;
        const file = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(file);
          if (!stat.isFile()) continue;
          if (stat.size + bytes > SOURCE_LIMIT) throw new Error("source fingerprint byte limit exceeded");
          const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            check();
            const length = readSync(file, buffer);
            if (!length) break;
            bytes += length;
            if (bytes > SOURCE_LIMIT) throw new Error("source fingerprint byte limit exceeded");
            digest.update(buffer.subarray(0, length));
          }
          records.push(fileRecord(path, digest.digest("hex")));
        } finally { closeSync(file); }
      } } finally { listing.closeSync(); }
    } finally { closeSync(fd); }
  };
  try { walk(realpathSync(root), "", 0); return sourceDigest(records); }
  catch { return null; }
}

// Binding the live repository also binds Unix sockets, and a network namespace
// does not isolate filesystem sockets. Copy only regular files into a private
// read-only view. Open every directory through its parent fd with O_NOFOLLOW:
// checking realpath and opening later would let a concurrent symlink swap copy
// a host file into that view. No source symlink or special file is followed.
async function sourceSnapshot(root: string, destination: string, deadline: number, excludePaths: string[]): Promise<string> {
  const records: string[] = [];
  let bytes = 0, entries = 0;
  const walk = async (source: string, target: string, relative: string, depth: number): Promise<void> => {
    if (performance.now() > deadline) throw new RuntimeFailure("timeout", "extension timeout while snapshotting source");
    if (depth > 64) throw new RuntimeFailure("source-limit", "extension source depth limit exceeded");
    const dir = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
      records.push(directoryRecord(relative));
      const anchor = `/proc/self/fd/${dir.fd}`;
      for await (const entry of await opendir(anchor)) {
        if (++entries > SOURCE_FILE_LIMIT) throw new RuntimeFailure("source-limit", "extension source entry limit exceeded");
        if (!extensionSourcePath(entry.name) || entry.isSymbolicLink()) continue;
        if (performance.now() > deadline) throw new RuntimeFailure("timeout", "extension timeout while snapshotting source");
        const from = `${anchor}/${entry.name}`, to = join(target, entry.name);
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (excludedSource(path, excludePaths)) continue;
        // Some filesystems report DT_UNKNOWN. Resolve metadata through the open
        // parent descriptor; subsequent opens still reject symlinks and races.
        const known = entry.isDirectory() || entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket();
        const metadata = known ? entry : await lstat(from);
        if (metadata.isDirectory()) { await walk(from, to, path, depth + 1); continue; }
        if (!metadata.isFile()) continue;
        const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) continue;
          if (stat.size + bytes > SOURCE_LIMIT) throw new RuntimeFailure("source-limit", "extension source byte limit exceeded");
          const chunks: Buffer[] = [], digest = createHash("sha256");
          while (true) {
            if (performance.now() > deadline) throw new RuntimeFailure("timeout", "extension timeout while snapshotting source");
            const buffer = Buffer.allocUnsafe(64 * 1024);
            const { bytesRead } = await handle.read(buffer);
            if (!bytesRead) break;
            bytes += bytesRead;
            if (bytes > SOURCE_LIMIT) throw new RuntimeFailure("source-limit", "extension source byte limit exceeded");
            digest.update(buffer.subarray(0, bytesRead));
            chunks.push(buffer.subarray(0, bytesRead));
          }
          await writeFile(to, Buffer.concat(chunks), { mode: 0o400, flag: "wx" });
          records.push(fileRecord(path, digest.digest("hex")));
        } finally { await handle.close(); }
      }
    } finally { await dir.close(); }
  };
  await walk(root, destination, "", 0);
  return sourceDigest(records);
}

export async function executeExtension(input: ExtensionExecutionInput, options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<ExtensionExecution> {
  const start = performance.now();
  let snapshot: string | undefined, inputFingerprint: string | undefined;
  const outcome = (status: ExtensionExecution["status"], reason?: string, extra: Partial<ExtensionExecution> = {}): ExtensionExecution =>
    ({ status, ...(inputFingerprint ? { inputFingerprint } : {}), ...(status === "failed" ? { reasonCode: "runtime-error" as const } : {}), ...(reason ? { reason: extensionDisplayText(reason) } : {}), log: [], durationMs: Math.round(performance.now() - start), ...extra });
  try {
    const timeoutMs = options.timeoutMs ?? EXTENSION_MAX_DURATION_MS, maxOutputBytes = options.maxOutputBytes ?? OUTPUT_LIMIT;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > EXTENSION_MAX_DURATION_MS
      || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > OUTPUT_LIMIT) {
      return outcome("failed", "invalid extension resource limits", { reasonCode: "invalid-input" });
    }
    if (!packagePath(input.entry) || !Array.isArray(input.files)) return outcome("failed", "invalid extension package entry", { reasonCode: "invalid-input" });
    const exclusions = input.excludePaths ?? [];
    if (!validExclusions(exclusions)) return outcome("failed", "invalid extension source exclusions", { reasonCode: "invalid-input" });
    const excludePaths = [...exclusions];
    const paths = new Set<string>();
    let packageBytes = 0;
    for (const file of input.files) {
      if (!packagePath(file.path) || typeof file.content !== "string" || paths.has(file.path)) return outcome("failed", "invalid extension package path", { reasonCode: "invalid-input" });
      packageBytes += Buffer.byteLength(file.content);
      if (packageBytes > OUTPUT_LIMIT || input.files.length > 4096) return outcome("failed", "extension package limit exceeded", { reasonCode: "invalid-input" });
      paths.add(file.path);
    }
    if (!paths.has(input.entry)) return outcome("failed", "extension package entry is absent", { reasonCode: "invalid-input" });
    const payload = JSON.stringify({ entry: input.entry, index: input.index, config: input.config });
    if (Buffer.byteLength(payload) > OUTPUT_LIMIT) return outcome("skipped", "extension context byte limit exceeded", { reasonCode: "context-too-large" });
    const capability = await isolationSupport();
    if (!capability.node) return outcome("skipped", capability.reason, { reasonCode: "isolation-unavailable" });
    const deadline = start + timeoutMs;
    snapshot = await mkdtemp(join(tmpdir(), "graft-extension-run-"));
    await mkdir(join(snapshot, "package"), { mode: 0o700 });
    await mkdir(join(snapshot, "runtime"), { mode: 0o700 });
    for (const file of input.files) {
      const target = join(snapshot, "package", file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { mode: 0o400, flag: "wx" });
    }
    inputFingerprint = "unavailable";
    inputFingerprint = await sourceSnapshot(await realpath(input.repoRoot), join(snapshot, "repo"), deadline, excludePaths);
    const workerName = import.meta.url.endsWith(".ts") ? "extension-worker.ts" : "extension-worker.js";
    await writeFile(join(snapshot, "runtime", workerName), await readFile(new URL(`./${workerName}`, import.meta.url)), { mode: 0o400 });
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return outcome("failed", "extension timeout before execution", { reasonCode: "timeout" });
    const result = await run("/usr/bin/prlimit", ["--as=4294967296", `--cpu=${Math.ceil(timeoutMs / 1000) + 1}`, "--nofile=128", "--core=0", "--",
      "/usr/bin/bwrap", ...sandboxArgs(capability.node, snapshot), "--allow-fs-read=/repo", "--allow-fs-read=/package",
      "--allow-fs-read=/runtime", "--disallow-code-generation-from-strings", `/runtime/${workerName}`], payload, remaining, maxOutputBytes);
    if (result.reason) return outcome("failed", result.reason, { reasonCode: result.reasonCode ?? "runtime-error" });
    if (result.code !== 0) return outcome("failed", "extension worker exited unsuccessfully");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)); }
    catch { return outcome("failed", "extension returned malformed output", { reasonCode: "output-rejected" }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return outcome("failed", "extension returned an unknown payload", { reasonCode: "output-rejected" });
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => !["nodes", "edges", "log", "error"].includes(key))
      || !Array.isArray(record.log) || record.log.some(item => typeof item !== "string")
      || Buffer.byteLength(JSON.stringify(record.log)) > STDERR_LIMIT) return outcome("failed", "extension returned an unknown payload", { reasonCode: "output-rejected" });
    const log = (record.log as string[]).map(line => extensionDisplayText(line));
    if (record.error !== undefined) return outcome("failed", typeof record.error === "string" ? record.error.slice(0, 1024) : "extension execution failed", { log, reasonCode: "extension-error" });
    if (!("nodes" in record) || !("edges" in record)) return outcome("failed", "extension returned an unknown payload", { reasonCode: "output-rejected" });
    return outcome("ok", undefined, { nodes: record.nodes, edges: record.edges, log });
  } catch (error) {
    return outcome("failed", error instanceof Error ? error.message.slice(0, 1024) : "extension runtime failed", { reasonCode: error instanceof RuntimeFailure ? error.reasonCode : "runtime-error" });
  } finally {
    if (snapshot) await rm(snapshot, { recursive: true, force: true }).catch(() => {});
  }
}
