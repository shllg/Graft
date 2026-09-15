import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { registerHooks, isBuiltin } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface SymbolEntry { id: string; name: string; kind: string; startLine: number; endLine: number }

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  entry: string; index: Record<string, SymbolEntry[]>; config: unknown;
};
const logs: string[] = [];
let logBytes = 0, logOverflow = false;
const finish = (value: unknown) => process.stdout.write(JSON.stringify(value));

// Permission grants are for data reads too. Without a separate module boundary,
// an approved entry could import a helper from the mutable repository instead of
// the approved package. Deny loader-registration APIs and non-package URLs; OS
// namespaces, not these hooks, contain hostile JavaScript.
const deniedBuiltin = (name: string) => ["module", "vm"].includes(name.replace(/^node:/, ""));
const getBuiltinModule = process.getBuiltinModule.bind(process);
Object.defineProperty(process, "getBuiltinModule", { configurable: false, writable: false, value: (name: string) => {
  if (deniedBuiltin(name)) throw new Error("extension module import is not allowed");
  return getBuiltinModule(name);
} });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (deniedBuiltin(specifier)) throw new Error("extension module import is not allowed");
    const result = nextResolve(specifier, context);
    if (isBuiltin(result.url)) {
      if (deniedBuiltin(result.url)) throw new Error("extension module import is not allowed");
      return result;
    }
    if (!result.url.startsWith("file:")) throw new Error("extension imports must be approved package files");
    const path = fileURLToPath(result.url);
    if (!path.startsWith("/package/")) throw new Error("extension imports must be approved package files");
    return result;
  },
});

function inside(path: string): string | null {
  if (typeof path !== "string" || path.includes("\0") || path.includes("\\")) return null;
  const absolute = resolve("/repo", path);
  if (absolute !== "/repo" && !absolute.startsWith("/repo/")) return null;
  return absolute;
}

const ids = new Set(Object.values(input.index).flatMap(list => list.map(node => node.id)));
const ctx = {
  repoRoot: "/repo",
  index: {
    byPath: input.index,
    has(id: string) { return ids.has(id); },
    enclosing(path: string, line: number) {
      let best: SymbolEntry | null = null;
      for (const node of input.index[path] ?? []) {
        if (node.kind === "file" || line < node.startLine || line > node.endLine) continue;
        if (!best || node.endLine - node.startLine < best.endLine - best.startLine) best = node;
      }
      return best;
    },
  },
  readFile(path: string): string | null {
    const absolute = inside(path);
    if (!absolute) return null;
    try { return readFileSync(absolute, "utf8"); } catch { return null; }
  },
  listFiles(path = "."): string[] {
    const absolute = inside(path), files: string[] = [];
    if (!absolute) return files;
    const walk = (dir: string) => {
      let entries;
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const file = join(dir, entry);
        const stat = lstatSync(file);
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile()) files.push(relative("/repo", file));
      }
    };
    walk(absolute);
    return files.sort();
  },
  config: input.config,
  log(message: unknown) {
    const text = String(message);
    logBytes += Buffer.byteLength(JSON.stringify(text)) + 1;
    if (logBytes > 64 * 1024 - 2) { logOverflow = true; throw new Error("extension log byte limit exceeded"); }
    logs.push(text);
  },
};

try {
  const mod = await import(pathToFileURL(join("/package", input.entry)).href);
  if (typeof mod.default !== "function") throw new Error("extension has no default export function");
  const result = await mod.default(ctx);
  if (logOverflow) throw new Error("extension log byte limit exceeded");
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.getPrototypeOf(result) !== Object.prototype
    || Object.keys(result).some(key => key !== "nodes" && key !== "edges")) throw new Error("extension returned an unknown payload");
  finish({ nodes: Object.hasOwn(result, "nodes") ? result.nodes : [], edges: Object.hasOwn(result, "edges") ? result.edges : [], log: logs });
} catch (error) {
  finish({ error: error instanceof Error ? error.message.slice(0, 1024) : "extension execution failed", log: logs });
}
