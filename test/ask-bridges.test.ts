import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ask, formatAsk } from "../src/ask/ask.js";
import type { GraphV1, NodeV1, Relation } from "../src/graph/types.js";

function fixture(t: { after(fn: () => void): void }, relation: Relation = "serves") {
  const base = mkdtempSync(join(tmpdir(), "graft-ask-bridge-"));
  const repo = join(base, "repo"), out = join(base, "context");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(out, ".graph"), { recursive: true });
  const node = (path: string, name: string, kind: NodeV1["kind"] = "function"): NodeV1 => ({
    id: `${path}#${name}`, path, name, kind, span: "L1-L3", signature: null,
    exported: true, origin: "ast", body_hash: "hash",
    summary_state: "pending", summary: null, crux: null,
  });
  const source = node("frontend/inventory.ts", "listArchiveInventory");
  const target = node("backend/dispatch.rb", "index", "method");
  const graph: GraphV1 = {
    meta: {
      version: 1, nodeCount: 10, edgeCount: 1, languages: ["typescript", "ruby"],
      scopes: [
        { prefix: "frontend", label: "frontend", markers: ["package.json"] },
        { prefix: "backend", label: "backend", markers: ["Gemfile"] },
      ],
    },
    nodes: [source, target, ...Array.from({ length: 8 }, (_, i) => node(`frontend/other${i}.ts`, `archiveOption${i}`))],
    edges: [{
      source: source.id, target: target.id, relation, confidence: "extension", origin: "extension",
      extension: "a".repeat(64), extensionDigest: "b".repeat(64), via: "GET /archives",
    }],
  };
  for (const n of graph.nodes) {
    mkdirSync(dirname(join(repo, n.path)), { recursive: true });
    writeFileSync(join(repo, n.path), n === target
      ? "def index\n  render json: records\nend\n"
      : "export function listArchiveInventory() {\n  return request('/archives')\n}\n");
  }
  const save = () => {
    graph.meta.nodeCount = graph.nodes.length;
    graph.meta.edgeCount = graph.edges.length;
    writeFileSync(join(out, ".graph/wiring.json"), JSON.stringify(graph));
  };
  save();
  return { repo, out, graph, source, target, save, node };
}

test("ask bridges: a selected frontend symbol supplies its proved controller with source and provenance", (t) => {
  const f = fixture(t), result = ask(f.repo, "archive inventory", { contextDir: f.out, source: true });
  const hit = result.hits.find(hit => hit.pointer === `${f.target.path}:${f.target.span}`);
  assert.ok(hit, "cross-scope controller must accompany its lexical frontend anchor");
  assert.equal(result.hits[0].pointer, `${f.source.path}:${f.source.span}`);
  assert.ok(result.hits.length <= 8);
  assert.equal(hit.relation, "serves");
  assert.equal(hit.evidence?.source, f.source.id);
  assert.equal(hit.evidence?.extension, "a".repeat(64));
  assert.equal(hit.evidence?.extensionDigest, "b".repeat(64));
  assert.equal(hit.evidence?.confidence, "extension");
  assert.match(hit.code!, /def index\n  render json: records/);
  assert.match(formatAsk(result), /serves.*extension.*GET \/archives/);
});

test("ask bridges: renders uses the same bounded evidence rule", (t) => {
  const f = fixture(t, "renders");
  f.graph.edges[0] = { source: f.source.id, target: f.target.id, relation: "renders", confidence: "convention" };
  f.save();
  const result = ask(f.repo, "archive inventory", { contextDir: f.out, limit: 2 });
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[1].relation, "renders");
  assert.equal(result.hits[1].evidence?.confidence, "convention");
});

test("ask bridges: ordinary cross-scope calls stay excluded and lexical-only mode does not expand", (t) => {
  const f = fixture(t, "calls");
  assert.ok(!ask(f.repo, "archive inventory", { contextDir: f.out }).hits.some(hit => hit.pointer.startsWith("backend/")));
  const serves = fixture(t);
  assert.ok(!ask(serves.repo, "archive inventory", { contextDir: serves.out, graphRank: false }).hits.some(hit => hit.pointer.startsWith("backend/")));
});

test("ask bridges: scope filters restrict both anchors and targets", (t) => {
  const f = fixture(t);
  const frontend = ask(f.repo, "archive inventory", { contextDir: f.out, in: "frontend/" });
  assert.ok(frontend.hits.length);
  assert.ok(frontend.hits.every(hit => hit.pointer.startsWith("frontend/")));
  assert.equal(ask(f.repo, "archive inventory", { contextDir: f.out, in: "backend" }).hits.length, 0);
});

test("ask bridges: fanout and chained bridges cannot fill or recursively expand the result budget", (t) => {
  const f = fixture(t), farther = f.node("backend/farther.rb", "deeper", "method");
  f.graph.nodes.push(farther);
  f.graph.edges.push({ ...f.graph.edges[0], source: f.target.id, target: farther.id });
  for (let i = 0; i < 30; i++) {
    const target = f.node(`backend/z${i}.rb`, `endpoint${i}`, "method");
    f.graph.nodes.push(target);
    f.graph.edges.push({ ...f.graph.edges[0], target: target.id });
  }
  f.graph.edges.push({ ...f.graph.edges[0] });
  f.save();
  const result = ask(f.repo, "archive inventory", { contextDir: f.out, limit: 8 });
  assert.equal(result.hits.filter(hit => hit.evidence).length, 1);
  assert.equal(result.hits.length, 8);
  assert.equal(new Set(result.hits.map(hit => hit.pointer)).size, 8);
  assert.ok(!result.hits.some(hit => hit.pointer.startsWith(farther.path)));
  assert.equal(ask(f.repo, "archive inventory", { contextDir: f.out, limit: 1 }).hits.length, 1);
});
