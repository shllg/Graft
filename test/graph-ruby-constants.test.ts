/**
 * Ruby constant resolution: `Module.nesting`, innermost first.
 *
 * M0 gave Ruby symbols but no way to say what `Runner` means inside
 * `module A; module B; class C`. Every constant reference resolved by bare name
 * or not at all, so `raise CrossTenantAccessError` produced no edge whatsoever —
 * nine raise sites in one real app pointing at a class the graph already had a
 * node for.
 *
 * The lookup implemented here is Ruby's own, in Ruby's own order: the nesting
 * chain innermost-first, then the innermost cref's ancestors, then top level.
 * Anything it cannot decide produces NO edge — a constant reference that binds
 * to the wrong class is worse than one that binds to nothing, because
 * `SKILL.md` tells the model to trust the answer and act.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-const-"));
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

/** Every `references` edge out of `source`, as target ids. */
const refs = (graph: GraphV1, source: string): string[] =>
  graph.edges.filter((e) => e.relation === "references" && e.source === source).map((e) => e.target).sort();

const withGraph = async (files: Record<string, string>, body: (g: GraphV1) => void): Promise<void> => {
  const { dir, graph } = await buildAndRead(files);
  try {
    body(graph);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("ruby constants: the nesting chain is searched innermost first", async () => {
  // Ruby tries A::B::C::Runner, then A::B::Runner, then A::Runner, then ::Runner.
  // Both A::B::Runner and A::Runner exist, so the INNER one must win — this is the
  // whole point of a nesting chain rather than a bare-name match.
  const src = `
module A
  class Runner; end

  module B
    class Runner; end

    class C
      def go
        Runner.new
      end
    end
  end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.deepEqual(refs(graph, "a.rb#A.B.C.go"), ["a.rb#A.B.Runner"]);
  });
});

test("ruby constants: a compact class body does NOT see the intermediate namespaces", async () => {
  // `class A::B::C` has Module.nesting == [A::B::C] only. The nested form would
  // also try A::B and A; the compact form does not, and the two are not
  // interchangeable. Real Rails code writes both, often in the same directory.
  const nested = `
module A
  class Helper; end

  module B
    class C
      def go
        Helper.new
      end
    end
  end
end
`;
  await withGraph({ "nested.rb": nested }, (graph) => {
    assert.deepEqual(refs(graph, "nested.rb#A.B.C.go"), ["nested.rb#A.Helper"], "the nested form reaches A::Helper");
  });

  const compact = `
module A
  class Helper; end
end

class A::B::C
  def go
    Helper.new
  end
end
`;
  await withGraph({ "compact.rb": compact }, (graph) => {
    assert.deepEqual(refs(graph, "compact.rb#A.B.C.go"), [], "the compact form must not reach A::Helper");
  });
});

test("ruby constants: a compact class definition is a node, scoped like the nested form", async () => {
  // `class App::InvitationsController` produced no node at all under M0, which is
  // why its `include` and superclass edges were missing and why its actions landed
  // as file-scoped `index`/`show` nodes that no query could tell apart. The id must
  // match what the nested spelling would have produced, or the two forms describe
  // the same class under two different names.
  const src = `
class App::InvitationsController
  def index; end
end
`;
  await withGraph({ "c.rb": src }, (graph) => {
    const cls = graph.nodes.find((n) => n.id === "c.rb#App.InvitationsController");
    assert.ok(cls, "the compact class has a node");
    assert.equal(cls!.kind, "class");
    assert.equal(cls!.name, "InvitationsController", "name is the bare constant, as call resolution matches it");
    const action = graph.nodes.find((n) => n.id === "c.rb#App.InvitationsController.index");
    assert.ok(action, "its methods nest under it rather than under the file");
    assert.equal(action!.owner, "InvitationsController");
  });
});

test("ruby constants: resolution continues into the innermost cref's ancestors", async () => {
  // Step 2 of Ruby's lookup. `Helper` is defined only inside Base, and Child names
  // it without qualification — legal because Child inherits Base's constants.
  const src = `
class Base
  class Helper; end
end

class Child < Base
  def go
    Helper.new
  end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.deepEqual(refs(graph, "a.rb#Child.go"), ["a.rb#Base.Helper"]);
  });
});

test("ruby constants: an included module's constants are reachable too", async () => {
  // `include` puts the module in the ancestor chain exactly as a superclass does,
  // and M0 already emits both as `extends` edges.
  const src = `
module Shapes
  class Circle; end
end

class Canvas
  include Shapes

  def draw
    Circle.new
  end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.deepEqual(refs(graph, "a.rb#Canvas.draw"), ["a.rb#Shapes.Circle"]);
  });
});

test("ruby constants: `::X` escapes the nesting chain to top level", async () => {
  // The leading `::` is the programmer saying "not the one you would have found."
  // Honouring it is what makes the shadowed inner class NOT the answer.
  const src = `
class Logger; end

module A
  class Logger; end

  class C
    def go
      ::Logger.new
    end
  end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.deepEqual(refs(graph, "a.rb#A.C.go"), ["a.rb#Logger"], "the top-level Logger, not A::Logger");
  });
});

test("ruby constants: a qualified reference names its terminal, not the namespace it walks through", async () => {
  // `TenantSecurity::CrossTenantAccessError` is a reference to the error class.
  // Emitting an edge into TenantSecurity as well would be a second, wrong answer,
  // and on a real app it lands on exactly the module a `callers` query is asked
  // about most.
  const src = `
module TenantSecurity
  class CrossTenantAccessError < StandardError; end
end

class Current
  def switch
    raise TenantSecurity::CrossTenantAccessError, "nope"
  end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.deepEqual(refs(graph, "a.rb#Current.switch"), ["a.rb#TenantSecurity.CrossTenantAccessError"]);
  });
});

test("ruby constants: `raise SomeError` inside its own module resolves", async () => {
  // The exact shape M1 exists to fix, minus the qualification: nine sites in
  // filewerk-rails raise a constant defined one nesting level up, and M0 emitted
  // nothing for any of them.
  const src = `
module TenantSecurity
  class CrossTenantAccessError < StandardError; end

  def validate!
    raise CrossTenantAccessError, "no access"
  end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.deepEqual(refs(graph, "a.rb#TenantSecurity.validate!"), ["a.rb#TenantSecurity.CrossTenantAccessError"]);
  });
});

test("ruby constants: two files defining the same constant produce NO edge", async () => {
  // Precision beats recall. Nothing in the source says which one is meant, and
  // outside a Rails app there is no autoload map to ask.
  const a = `
module Shared
  class Thing; end
end
`;
  const b = `
module Shared
  class Thing; end
end
`;
  const c = `
class User
  def go
    Shared::Thing.new
  end
end
`;
  await withGraph({ "a.rb": a, "b.rb": b, "c.rb": c }, (graph) => {
    assert.deepEqual(refs(graph, "c.rb#User.go"), []);
  });
});

test("ruby constants: an unknown constant produces no edge and no dangling target", async () => {
  // Gems and stdlib are the common case — most constants a Rails file names are
  // not in the repo at all. Heritage keeps an unresolved name as the edge target;
  // references must not, or every `ActiveRecord::Base` becomes a fake node id.
  const src = `
class User
  def go
    ActiveRecord::Base.connection
    JSON.parse("{}")
  end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.deepEqual(refs(graph, "a.rb#User.go"), []);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      if (e.relation === "references") assert.ok(ids.has(e.target), `${e.target} is a real node`);
    }
  });
});

test("ruby constants: a constant assignment is a definition, not a reference to itself", async () => {
  const src = `
module Config
  TIMEOUT = 30
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.equal(
      graph.edges.some((e) => e.relation === "references" && e.source.startsWith("a.rb#Config")),
      false,
    );
  });
});

test("ruby constants: a class name is not a reference to the class", async () => {
  // `class Foo` and `module Foo` name a definition. A self-referencing edge here
  // would show up as every class calling itself.
  const src = `
module A
  class Foo; end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.deepEqual(
      graph.edges.filter((e) => e.relation === "references").map((e) => `${e.source}->${e.target}`),
      [],
    );
  });
});

test("ruby constants: a qualified superclass resolves through the same lookup", async () => {
  // `class App::InvitationsController < App::BaseController` — M0 required the
  // superclass to be a plain `constant`, so a namespaced parent emitted nothing.
  const src = `
module App
  class BaseController; end
end

class App::InvitationsController < App::BaseController
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.ok(
      graph.edges.some(
        (e) =>
          e.relation === "extends" &&
          e.source === "a.rb#App.InvitationsController" &&
          e.target === "a.rb#App.BaseController",
      ),
      "the namespaced superclass resolves to the class node, not to a bare name",
    );
  });
});

test("ruby constants: a qualified mixin resolves through the same lookup", async () => {
  const src = `
module Auth
  module Helper
    def check; end
  end
end

class Session
  include Auth::Helper
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "extends" && e.source === "a.rb#Session" && e.target === "a.rb#Auth.Helper",
      ),
    );
  });
});

test("ruby constants: a cross-file reference resolves and is marked inferred", async () => {
  // Same-file is certain; another file in the repo is a repo-wide match, and the
  // confidence has to say so — that is the whole two-tier provenance contract.
  const lib = `
module Billing
  class Invoice; end
end
`;
  const app = `
class Checkout
  def run
    Billing::Invoice.new
  end
end
`;
  await withGraph({ "lib.rb": lib, "app.rb": app }, (graph) => {
    const e = graph.edges.find((x) => x.relation === "references" && x.source === "app.rb#Checkout.run");
    assert.ok(e, "the reference resolves across files");
    assert.equal(e!.target, "lib.rb#Billing.Invoice");
    assert.equal(e!.confidence, "inferred");
  });
});

test("ruby constants: a same-file reference is marked extracted", async () => {
  const src = `
module Billing
  class Invoice; end
end

class Checkout
  def run
    Billing::Invoice.new
  end
end
`;
  await withGraph({ "a.rb": src }, (graph) => {
    const e = graph.edges.find((x) => x.relation === "references" && x.source === "a.rb#Checkout.run");
    assert.equal(e!.confidence, "extracted");
  });
});

test("ruby constants: a constant never resolves into another language's file", async () => {
  // The guard test/graph-cross-language.test.ts exists for. A TypeScript class
  // named `Invoice` is not what a Ruby file means by `Invoice`, and the FQN index
  // must be Ruby-only rather than relying on the caller to filter.
  const ts = `export class Invoice {}\n`;
  const rb = `
class Checkout
  def run
    Invoice.new
  end
end
`;
  await withGraph({ "invoice.ts": ts, "a.rb": rb }, (graph) => {
    assert.deepEqual(refs(graph, "a.rb#Checkout.run"), []);
  });
});
