import { syncBuiltinESMExports } from "node:module";
import fsPromises from "node:fs/promises";
import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { executeExtension, extensionInputFingerprint, extensionOutputExclusions, extensionDisplayJson } from "../src/graph/extension-runtime.js";

async function fixture(fn: (repo: string, outside: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "graft-extension-test-"));
  try {
    const repo = join(root, "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "a.ts"), "source π 🦊");
    await writeFile(join(root, "marker"), "harmless outside marker");
    await fn(repo, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function input(repoRoot: string, content: string, extra: Array<{ path: string; content: string }> = []) {
  return {
    repoRoot, entry: "extension.mjs", files: [{ path: "extension.mjs", content }, ...extra],
    index: { "src/a.ts": [
      { id: "src/a.ts", name: "a.ts", kind: "file", startLine: 1, endLine: 5 },
      { id: "src/a.ts#f", name: "f", kind: "function", startLine: 1, endLine: 3 },
    ] }, config: { answer: 42 },
  };
}

test("extension runtime: approved helper snapshot and source context work", async (t) => fixture(async (repo) => {
  await writeFile(join(repo, "helper.mjs"), "export const value = 99;");
  const result = await executeExtension(input(repo, `
    import { value } from './helper.mjs';
    export default ctx => { ctx.log('π 🦊'); return { nodes: [], edges: [{
      value, config: ctx.config.answer, root: ctx.repoRoot,
      source: ctx.readFile('src/a.ts'), missing: ctx.readFile('../marker'),
      files: ctx.listFiles('src'), id: ctx.index.enclosing('src/a.ts', 2)?.id,
      has: ctx.index.has('src/a.ts#f')
    }] }; }`, [{ path: "helper.mjs", content: "export const value = 7;" }]));
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "ok", result.reason);
  assert.deepEqual(result.edges, [{ value: 7, config: 42, root: "/repo", source: "source π 🦊", missing: null,
    files: ["src/a.ts"], id: "src/a.ts#f", has: true }]);
  assert.deepEqual(result.log, ["π 🦊"]);
}));

test("extension runtime: symlinks, host files, writes, environment and subprocesses are denied", async (t) => fixture(async (repo, outside) => {
  await symlink("../marker", join(repo, "escape"));
  const result = await executeExtension(input(repo, `
    import fs from 'node:fs'; import cp from 'node:child_process';
    export default ctx => {
      const attempt = fn => { try { fn(); return true; } catch { return false; } };
      return { edges: [{ symlink: ctx.readFile('escape'),
        outside: attempt(() => fs.readFileSync(${JSON.stringify(join(outside, "marker"))})),
        write: attempt(() => fs.writeFileSync('/repo/src/a.ts', 'changed')),
        child: attempt(() => cp.spawnSync('/usr/bin/true')),
        env: Object.keys(process.env).filter(k => k !== 'PWD'), files: ctx.listFiles() }] };
    }`));
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "ok", result.reason);
  assert.deepEqual(result.edges, [{ symlink: null, outside: false, write: false, child: false, env: [], files: ["src/a.ts"] }]);
  assert.equal(await readFile(join(repo, "src/a.ts"), "utf8"), "source π 🦊");
}));

test("extension runtime: host loopback cannot be reached", async (t) => fixture(async (repo) => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await executeExtension(input(repo, `
      import net from 'node:net';
      export default async () => ({ edges: [{ connected: await new Promise(resolve => {
        try { const s = net.connect(${address.port}, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(true); });
          s.on('error', () => resolve(false)); } catch { resolve(false); }
      }) }] });`));
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "ok", result.reason);
    assert.deepEqual(result.edges, [{ connected: false }]);
    assert.equal(connections, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}));

test("extension runtime: source snapshots omit hidden files, credentials, generated data and Unix sockets", { skip: process.platform !== "linux" }, async (t) => fixture(async (repo) => {
  for (const name of [".git", ".config", "vendor", "node_modules", "tmp", "log", "coverage", "dist", "build", "graft"]) {
    await mkdir(join(repo, name));
    await writeFile(join(repo, name, "synthetic.txt"), "synthetic omitted data");
  }
  for (const name of [".env", ".env.local", "private.key", "credentials.json", "secrets.yaml"]) {
    await writeFile(join(repo, name), "synthetic omitted data");
  }
  const socketPath = join(repo, "synthetic.sock");
  const server = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const result = await executeExtension(input(repo, "export default ctx => ({ edges: [{ files: ctx.listFiles(), socket: ctx.readFile('synthetic.sock'), hidden: ctx.readFile('.env') }] });"));
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "ok", result.reason);
    assert.deepEqual(result.edges, [{ files: ["src/a.ts"], socket: null, hidden: null }]);
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}));

test("extension runtime: explicit invalid collection values survive for atomic parent validation", async (t) => fixture(async (repo) => {
  const result = await executeExtension(input(repo, "export default () => ({ nodes: null, edges: false });"));
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "ok", result.reason);
  assert.equal(result.nodes, null);
  assert.equal(result.edges, false);
}));

test("extension runtime: mutable repository modules and loader overrides cannot be imported", async (t) => fixture(async (repo) => {
  await writeFile(join(repo, "unapproved.mjs"), "export default 99;");
  for (const specifier of ["/repo/unapproved.mjs", "file:///repo/unapproved.mjs", "node:module", "node:vm", "data:text/javascript,export default 99"]) {
    const result = await executeExtension(input(repo, `import value from ${JSON.stringify(specifier)}; export default () => ({ edges: [{ value }] });`));
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "failed", specifier);
    assert.match(result.reason!, /import|module|package/i);
  }
}));

test("extension runtime: SIGTERM resistance cannot outlive the hard deadline", async (t) => fixture(async (repo) => {
  const started = performance.now();
  const result = await executeExtension(input(repo, "process.on('SIGTERM', () => {}); export default () => { while (true) {} };"), { timeoutMs: 250 });
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "failed");
  assert.match(result.reason!, /timeout/i);
  assert.equal(result.reasonCode, "timeout");
  assert.ok(performance.now() - started < 4000);
}));

test("extension runtime: throwing and unknown payloads return failures", async (t) => fixture(async (repo) => {
  for (const source of ["export default () => { throw Error('synthetic failure') };", "export default () => 7;",
    "export default () => null;", "export default () => ({ unexpected: true });", "export default () => { process.stdout.write('not json'); return {}; };"]) {
    const result = await executeExtension(input(repo, source));
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "failed", source);
    assert.ok(result.reason);
  }
}));

test("extension runtime: stdout bytes, stderr bytes and logs are bounded", async (t) => fixture(async (repo) => {
  for (const source of ["export default () => ({ edges: [{ text: '🦊'.repeat(600) }] });",
    "process.stderr.write('x'.repeat(70000)); export default () => ({});",
    "export default ctx => { for (let i = 0; i < 10000; i++) ctx.log('x'.repeat(1000)); return {}; };"]) {
    const result = await executeExtension(input(repo, source), { maxOutputBytes: 2000 });
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "failed", source);
    assert.match(result.reason!, /limit|large/i);
  }
}));

test("extension runtime: split UTF-8 is decoded only after collecting bytes", async (t) => fixture(async (repo) => {
  const result = await executeExtension(input(repo, `export default async () => {
    const bytes = Buffer.from(JSON.stringify({ nodes: [], edges: [{ text: 'π 🦊' }], log: [] }));
    for (const byte of bytes) { process.stdout.write(Buffer.from([byte])); await new Promise(r => setTimeout(r, 1)); }
    process.exit(0);
  };`));
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "ok", result.reason);
  assert.deepEqual(result.edges, [{ text: "π 🦊" }]);
}));

test("extension runtime: invalid snapshot paths fail", async () => fixture(async (repo) => {
  for (const path of ["../escape.mjs", "/absolute.mjs", "a/../b.mjs", "a\\b.mjs", "a\u0000b.mjs"]) {
    const result = await executeExtension(input(repo, "export default () => ({});", [{ path, content: "" }]));
    assert.equal(result.status, "failed", path);
  }
}));

test("extension runtime: scratch snapshots are cleaned after success and forced termination", async (t) => fixture(async (repo, outside) => {
  // An isolated TMPDIR lets this assert cleanup without racing concurrent tests
  // in other test-runner processes that also execute extensions.
  const scratch = join(outside, "scratch");
  await mkdir(scratch);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    for (const content of ["export default () => ({});", "export default () => { while (true) {} };"]) {
      const result = await executeExtension(input(repo, content), { timeoutMs: content.includes("while") ? 250 : 2000 });
      if (result.status === "skipped") return t.skip(result.reason);
      assert.equal(result.status, content.includes("while") ? "failed" : "ok", result.reason);
      assert.deepEqual(await readdir(scratch), []);
    }
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}));

test("extension runtime: denied loader registration cannot be restored through getBuiltinModule", async (t) => fixture(async (repo) => {
  const result = await executeExtension(input(repo, `export default async () => {
    let imported = false;
    try { process.getBuiltinModule('module').registerHooks({ resolve() { return { url: 'data:text/javascript,export default 1', shortCircuit: true }; } }); imported = true; } catch {}
    return { edges: [{ imported }] };
  };`));
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "ok", result.reason);
  assert.deepEqual(result.edges, [{ imported: false }]);
}));

test("extension runtime: invalid UTF-8 output and early pipe closure are contained", async (t) => fixture(async (repo) => {
  for (const content of ["process.stdout.write(Buffer.from([123, 34, 255, 34, 58, 49, 125])); process.exit(0);",
    "process.stdin.destroy(); process.exit(0);"]) {
    const result = await executeExtension(input(repo, content));
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "failed");
    assert.ok(result.reason);
  }
}));

test("extension runtime: deeply nested source trees have a traversal limit", async (t) => fixture(async (repo) => {
  await mkdir(join(repo, ...Array.from({ length: 66 }, () => "nested")), { recursive: true });
  const result = await executeExtension(input(repo, "export default () => ({});"));
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "failed");
  assert.match(result.reason!, /source.*limit/i);
}));

test("extension runtime: hostile terminal controls in logs and errors are replaced at the boundary", async (t) => fixture(async (repo) => {
  const hostile = "before\u001b[2K\r\n\u009b1A\u007f\u2028\u2029after";
  const result = await executeExtension(input(repo, `export default ctx => { ctx.log(${JSON.stringify(hostile)}); ctx.log('x'.repeat(5000)); throw Error(${JSON.stringify(hostile)}); };`));
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "failed");
  for (const text of [...result.log, result.reason!]) {
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    assert.ok(text.length <= 1024);
  }
  assert.match(result.reason!, /before.*after/);
}));

test("extension runtime: oversized context skips before reading or copying the repository", async () => {
  const data = input("/a-synthetic-repository-that-does-not-exist", "export default () => ({});");
  data.index["src/a.ts"][0].name = "x".repeat(17 * 1024 * 1024);
  const result = await executeExtension(data);
  assert.equal(result.status, "skipped");
  assert.match(result.reason!, /context byte limit/);
  assert.equal(result.reasonCode, "context-too-large");
});


test("extension runtime: unknown directory entry types preserve safe source files and reject symlinks", async (t) => fixture(async (repo, outside) => {
  await symlink(join(outside, "marker"), join(repo, "unknown-link"));
  const actual = fsPromises.opendir;
  const replacement = t.mock.method(fsPromises, "opendir", async (...args) => {
    const dir = await actual(...args);
    return { async *[Symbol.asyncIterator]() {
      for await (const entry of dir) yield { name: entry.name,
        isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
        isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };
    } };
  });
  syncBuiltinESMExports();
  try {
    const result = await executeExtension(input(repo, "export default ctx => ({edges:[ctx.listFiles(),ctx.readFile('src/a.ts'),ctx.readFile('unknown-link')]});"));
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "ok", result.reason);
    assert.deepEqual(result.edges, [["src/a.ts"], "source π 🦊", null]);
  } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
}));

test("extension JSON terminal escaping preserves parsed values", () => {
  const value = { path: "x\u001b\u0085\u009b\u2028\u2029y" };
  const text = extensionDisplayJson(value);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);
  assert.deepEqual(JSON.parse(text), value);
});


test("unsupported isolation is a classified skip without repository access", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process,"platform")!;
  Object.defineProperty(process,"platform",{value:"win32"});
  try {
    const result = await executeExtension(input("/synthetic-missing-repository","export default () => ({});"));
    assert.equal(result.status,"skipped"); assert.equal(result.reasonCode,"isolation-unavailable");
  } finally {Object.defineProperty(process,"platform",descriptor);}
});

test("a failed isolation capability probe is retried in the same runtime after support returns", async (t) => fixture(async (repo) => {
  const healthy = await executeExtension(input(repo, "export default () => ({});"));
  if (healthy.status === "skipped") return t.skip(healthy.reason);
  // A fresh process avoids the successful capability cache from earlier tests
  // without changing import.meta.url, which selects the matching source worker.
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { executeExtension } from './src/graph/extension-runtime.ts';
    const data = JSON.parse(process.argv[1]);
    const access = fs.access;
    fs.access = async () => { throw Object.assign(new Error('SYNTHETIC_UNAVAILABLE'), { code: 'EACCES' }); };
    syncBuiltinESMExports();
    const unavailable = await executeExtension({...data, repoRoot:'/synthetic-missing-repository'});
    fs.access = access; syncBuiltinESMExports();
    const recovered = await executeExtension(data);
    process.stdout.write(JSON.stringify({before:unavailable.status, reason:unavailable.reasonCode, after:recovered.status}));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
    JSON.stringify(input(repo, "export default () => ({});"))], { encoding: "utf8", timeout: 10_000 }));
  assert.deepEqual(result, { before: "skipped", reason: "isolation-unavailable", after: "ok" });
}));


test("extension source fingerprints cover exact bytes and empty directories, excluding symlinks and secrets", async () => fixture(async (repo, outside) => {
  const original = extensionInputFingerprint(repo);
  assert.match(original!, /^[a-f0-9]{64}$/);
  await symlink(join(outside, "marker"), join(repo, "alias"));
  await writeFile(join(repo, ".env.synthetic"), "not a credential");
  await writeFile(join(repo, "credentials.synthetic.json"), "not a credential");
  assert.equal(extensionInputFingerprint(repo), original);
  await mkdir(join(repo, "empty"));
  const directory = extensionInputFingerprint(repo);
  assert.notEqual(directory, original);
  await writeFile(join(repo, "empty", "routes.json"), '{"version":1}');
  const content = extensionInputFingerprint(repo);
  assert.notEqual(content, directory);
  const stat = await fsPromises.stat(join(repo, "empty", "routes.json"));
  await writeFile(join(repo, "empty", "routes.json"), '{"version":2}');
  await fsPromises.utimes(join(repo, "empty", "routes.json"), stat.atime, stat.mtime);
  assert.notEqual(extensionInputFingerprint(repo), content, "same-size/same-mtime edits are compared by bytes");
  assert.equal(extensionInputFingerprint(repo, ["empty"]), original);
}));

test("execution fingerprints describe captured bytes even when live input changes during capture", async (t) => fixture(async (repo) => {
  await writeFile(join(repo, "routes.json"), '{"version":1}');
  const before = extensionInputFingerprint(repo), actual = fsPromises.writeFile;
  const replacement = t.mock.method(fsPromises, "writeFile", async (...args) => {
    await actual(...args);
    if (String(args[0]).endsWith("/repo/routes.json") && String(args[0]) !== join(repo, "routes.json")) {
      await actual(join(repo, "routes.json"), '{"version":2}');
    }
  });
  syncBuiltinESMExports();
  try {
    const result = await executeExtension(input(repo, "export default ctx => ({edges:[ctx.readFile('routes.json')]});"));
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "ok", result.reason);
    assert.deepEqual(result.edges, ['{"version":1}']);
    assert.equal(result.inputFingerprint, before);
    assert.notEqual(result.inputFingerprint, extensionInputFingerprint(repo));
  } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
}));

test("failed executions keep their captured input fingerprint", async (t) => fixture(async (repo) => {
  const result = await executeExtension(input(repo, "export default () => { throw Error('synthetic failure'); };"));
  if (result.status === "skipped") return t.skip(result.reason);
  assert.equal(result.status, "failed");
  assert.equal(result.inputFingerprint, extensionInputFingerprint(repo));
}));

test("source output exclusions cover lexical and canonical locations without excluding sibling prefixes", async () => fixture(async (repo, outside) => {
  await mkdir(join(repo, "actual"));
  await symlink(join(repo, "actual"), join(outside, "output-link"));
  assert.deepEqual(extensionOutputExclusions(repo, join(outside, "output-link", "nested")), ["actual/nested"]);
  assert.deepEqual(extensionOutputExclusions(repo, join(repo, "custom")), ["custom"]);
  assert.deepEqual(extensionOutputExclusions(repo, repo + "-other"), []);
}));


test("source fingerprints fail closed on invalid exclusions and oversized inputs", async () => fixture(async (repo) => {
  assert.equal(extensionInputFingerprint(repo, ["../outside"]), null);
  const file = await fsPromises.open(join(repo, "large.bin"), "w");
  try { await file.truncate(256 * 1024 * 1024 + 1); }
  finally { await file.close(); }
  assert.equal(extensionInputFingerprint(repo), null);
}));


test("source comparison accepts the same simulated slow I/O as snapshot capture", async (t) => fixture(async (repo) => {
  const realNow = performance.now.bind(performance);
  const actualOpen = fsPromises.open, actualReadSync = fs.readSync;
  let elapsed = 0, captureDelayed = false, comparisonDelayed = false, delay = 6000;
  const clock = t.mock.method(performance, "now", () => realNow() + elapsed);
  const opening = t.mock.method(fsPromises, "open", async (...args) => {
    const handle = await actualOpen(...args);
    if (typeof args[1] === "number" && !(args[1] & fs.constants.O_DIRECTORY)) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...readArgs) => {
        const result = await read(...readArgs);
        if (!captureDelayed && result.bytesRead) { elapsed += delay; captureDelayed = true; }
        return result;
      });
    }
    return handle;
  });
  const reading = t.mock.method(fs, "readSync", (...args) => {
    const length = actualReadSync(...args);
    if (!comparisonDelayed && length) { elapsed += delay; comparisonDelayed = true; }
    return length;
  });
  syncBuiltinESMExports();
  try {
    const result = await executeExtension(input(repo, "export default () => ({});"));
    if (result.status === "skipped") return t.skip(result.reason);
    assert.equal(result.status, "ok", result.reason);
    assert.equal(captureDelayed, true);
    assert.ok(result.durationMs >= delay);
    assert.equal(extensionInputFingerprint(repo), result.inputFingerprint,
      "a six-second input captured successfully must remain fresh with the same comparison delay");
    assert.equal(comparisonDelayed, true);
    comparisonDelayed = false;
    delay = 16000;
    assert.equal(extensionInputFingerprint(repo), null, "comparison remains bounded beyond the shared deadline");
  } finally {
    opening.mock.restore(); reading.mock.restore(); clock.mock.restore();
    syncBuiltinESMExports();
  }
}));
