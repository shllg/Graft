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
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";
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

/*
 * Ancestor ORDER, and the two places Ruby's own order is not the emission order.
 *
 * Every expectation below was taken from `ruby -e`, not from the language spec:
 * the three cases each resolved to a different constant than this code produced
 * before, and all three carried `confidence: "extracted"` while doing it.
 */

test("ruby constants: an include beats the superclass, the way Ruby orders ancestors", async () => {
  // `Child.ancestors` is `[Child, Mix, Base]` — a module included in the class sits
  // ABOVE the superclass. Resolving to `Base::Inner` here is a wrong edge, not a
  // missing one, and heritage edges arrive superclass-first because that is the
  // order the syntax puts them in, not the order Ruby searches them in.
  await withGraph(
    {
      "base.rb": `class Base\n  class Inner; end\nend\n`,
      "mix.rb": `module Mix\n  class Inner; end\nend\n`,
      "child.rb": `class Child < Base\n  include Mix\n  def go\n    Inner.new\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "child.rb#Child.go"), ["mix.rb#Mix.Inner"]);
    },
  );
});

test("ruby constants: the LAST include wins, because each one inserts nearest", async () => {
  // `include A; include B` gives `[C, B, A]`. Declaration order and search order
  // are exact opposites, so taking them as emitted is wrong every single time two
  // included modules define the same name.
  await withGraph(
    {
      "a.rb": `module A\n  class Inner; end\nend\n`,
      "b.rb": `module B\n  class Inner; end\nend\n`,
      "c.rb": `class C\n  include A\n  include B\n  def go\n    Inner.new\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "c.rb#C.go"), ["b.rb#B.Inner"]);
    },
  );
});

test("ruby constants: a prepended module beats the superclass", async () => {
  // `prepend` lands in front of the class itself: `[P, C, Base]`.
  await withGraph(
    {
      "p.rb": `module P\n  class Inner; end\nend\n`,
      "base.rb": `class Base\n  class Inner; end\nend\n`,
      "c.rb": `class C < Base\n  prepend P\n  def go\n    Inner.new\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "c.rb#C.go"), ["p.rb#P.Inner"]);
    },
  );
});

test("ruby constants: `extend` contributes nothing to constant lookup", async () => {
  // The one that reads wrong until you say it out loud: `extend` composes the
  // SINGLETON class, and step 2 of constant lookup walks `cref.ancestors`, which
  // `extend` never enters. Ruby answers `::Inner` here — from an instance method
  // and from a class method alike, because constant lookup is lexical and does not
  // care what `self` is.
  await withGraph(
    {
      "mix.rb": `module Mix\n  class Inner; end\nend\n`,
      "top.rb": `class Inner; end\n`,
      "c.rb": `class C\n  extend Mix\n  def go\n    Inner.new\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "c.rb#C.go"), ["top.rb#Inner"]);
    },
  );
});

test("ruby constants: a qualified reference commits to the namespace its head named", async () => {
  // Ruby resolves `B` in `B::X` first, to `A::B`, and then looks for `X` inside it
  // — finding `Base::X` by inheritance. It never reconsiders the top-level `B`.
  // Trying the whole dotted path at each nesting level instead looks like a
  // harmless shortcut and answers `BTop::X`, which this program never touches.
  await withGraph(
    {
      "base.rb": `class Base\n  class X; end\nend\n`,
      "ab.rb": `module A\n  class B < Base; end\nend\n`,
      "btop.rb": `module B\n  class X; end\nend\n`,
      "use.rb": `module A\n  class Caller\n    def go\n      B::X.new\n    end\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "use.rb#A.Caller.go"), ["base.rb#Base.X"]);
    },
  );
});

test("ruby constants: a compact-form namespace still resolves through the flat scan", async () => {
  // The recall half of the commit rule. `class Billing::Invoice` mints no `Billing`
  // node, so there is no head to commit to and the flat scan is the only evidence
  // there is. Losing this to fix the case above would have traded one wrong answer
  // for a whole class of missing ones.
  await withGraph(
    {
      "lib.rb": `class Billing::Invoice; end\n`,
      "use.rb": `class Checkout\n  def run\n    Billing::Invoice.new\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "use.rb#Checkout.run"), ["lib.rb#Billing.Invoice"]);
    },
  );
});

test("ruby constants: a constant ASSIGNMENT shadows an outer class of that name", async () => {
  // `X = 123` inside `module A` is `A::X`, and Ruby's search stops there. There is
  // no node to point at — the value is an integer — so the right answer is no edge.
  // Walking past it to an unrelated top-level `class X` answers a question the
  // source never asked.
  await withGraph(
    {
      "a.rb": `module A\n  X = 123\n  class Caller\n    def go\n      X\n    end\n  end\nend\n`,
      "x.rb": `class X; end\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "a.rb#A.Caller.go"), []);
    },
  );
});

test("ruby constants: a shadow one level out does not suppress a nearer real match", async () => {
  // The guard on the guard: shadowing must stop the search exactly where Ruby's
  // would stop, never earlier. `A::B::Thing` is found before `A::Thing = 1` is
  // ever consulted.
  await withGraph(
    {
      "a.rb":
        `module A\n  Thing = 1\n  module B\n    class Thing; end\n    class Caller\n` +
        `      def go\n        Thing.new\n      end\n    end\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "a.rb#A.B.Caller.go"), ["a.rb#A.B.Thing"]);
    },
  );
});

test("ruby constants: a namespace reopened by many files is still one namespace", async () => {
  // The head of a qualified reference only has to EXIST; it does not have to be
  // pinned to one node. Every controller in a Rails app reopens `module App`, and
  // treating twenty reopenings as an ambiguous choice made `App::BaseController`
  // unresolvable — the tail was never reached at all. Only the terminal segment,
  // the one an edge actually points at, has to be unambiguous.
  await withGraph(
    {
      "a.rb": `module App\n  class BaseController; end\nend\n`,
      "b.rb": `module App\n  class Widgets; end\nend\n`,
      "c.rb": `module App\n  class Gadgets; end\nend\n`,
      "d.rb": `class Thing\n  def go\n    App::BaseController.new\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "d.rb#Thing.go"), ["a.rb#App.BaseController"]);
    },
  );
});

test("ruby constants: a qualified tail resolves through the head's superclass", async () => {
  // `Schemas::BaseEvent::ValidationError` where `ValidationError` is defined on
  // `BaseSchema`, which `BaseEvent` inherits from. Ruby finds it; trying the whole
  // dotted path at each nesting level never could, because no node is named
  // `Schemas::BaseEvent::ValidationError` anywhere.
  await withGraph(
    {
      "base.rb": `module Schemas\n  class BaseSchema\n    class ValidationError < StandardError; end\n  end\nend\n`,
      "event.rb": `module Schemas\n  class BaseEvent < BaseSchema; end\nend\n`,
      "t.rb": `class T\n  def go\n    raise Schemas::BaseEvent::ValidationError\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "t.rb#T.go"), ["base.rb#Schemas.BaseSchema.ValidationError"]);
    },
  );
});

// These fixtures resolve in memory: factory validation needs the repository's
// constants, but none of its filesystem/autoload conventions.
function factoryGraph(files: Record<string, string>): GraphV1 {
  const extracted = Object.entries(files).map(([path, source]) => extractFile(path, source, "ruby"));
  const nodes = extracted.flatMap(result => result.nodes);
  const edges = resolveEdges(nodes, extracted.flatMap(result => result.rawEdges));
  return { nodes, edges } as GraphV1;
}
const factoryCalls = (graph: GraphV1, source: string) => graph.edges
  .filter(edge => edge.source === source && edge.relation === "calls").map(edge => edge.target).sort();

test("ruby class factories: named subclasses own methods and reach inherited call", () => {
  const graph = factoryGraph({ "a.rb": `class Base
  def call; perform; end
end
class BaseTest
  RaisingTool = Class.new(Base) do
    def perform; raise "failed"; end
  end
  def run; RaisingTool.new.call; end
end` });
  assert.ok(graph.nodes.some(node => node.id === "a.rb#BaseTest.RaisingTool" && node.kind === "class"));
  assert.ok(graph.nodes.some(node => node.id === "a.rb#BaseTest.RaisingTool.perform" && node.owner === "RaisingTool"));
  assert.ok(!graph.nodes.some(node => node.id === "a.rb#BaseTest.perform"));
  assert.ok(graph.edges.some(edge => edge.source === "a.rb#BaseTest.RaisingTool" && edge.relation === "extends" && edge.target === "a.rb#Base"));
  assert.deepEqual(factoryCalls(graph, "a.rb#BaseTest.run"), ["a.rb#Base.call"]);
});

test("ruby class factories: error attributes and initializer belong to the error", () => {
  const graph = factoryGraph({ "a.rb": `class CalendarProvider
  Error = Class.new(StandardError) do
    attr_reader :reason
    def initialize(reason); @reason = reason; end
    def self.label; end
  end
  def initialize; end
  def run; Error.new("failure").reason; Error.label; end
end` });
  assert.equal(graph.nodes.filter(node => node.id.startsWith("a.rb#CalendarProvider.initialize")).length, 1);
  for (const name of ["reason", "initialize", "label"]) assert.ok(graph.nodes.some(node => node.id === `a.rb#CalendarProvider.Error.${name}` && node.owner === "Error"));
  assert.deepEqual(factoryCalls(graph, "a.rb#CalendarProvider.run"), ["a.rb#CalendarProvider.Error.label", "a.rb#CalendarProvider.Error.reason"]);
});

test("ruby class factories: no-block subclasses retain static lexical superclass lookup", () => {
  const graph = factoryGraph({ "a.rb": `class Base; def outer; end; end
module Suite
  class Base; def call; end; end
  Child = Class.new(Base)
  def run; Child.new.call; end
end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#Suite.run"), ["a.rb#Suite.Base.call"]);
  assert.ok(graph.edges.some(edge => edge.source === "a.rb#Suite.Child" && edge.relation === "extends" && edge.target === "a.rb#Suite.Base"));
});

test("ruby class factories: a block retains its lexical cref while self uses the new owner", () => {
  const graph = factoryGraph({ "a.rb": `class Base
  class Helper; def wrong; end; end
end
module Suite
  class Helper; def call; end; end
  Child = Class.new(Base) do
    def helper; Helper.new; end
    def run; helper.call; end
  end
end` });
  assert.deepEqual(refs(graph, "a.rb#Suite.Child.helper"), ["a.rb#Suite.Helper"]);
  assert.deepEqual(factoryCalls(graph, "a.rb#Suite.Child.run"), ["a.rb#Suite.Child.helper", "a.rb#Suite.Helper.call"]);
});

test("ruby class factories: instance and class ivars remain isolated from the outer class", () => {
  const graph = factoryGraph({ "a.rb": `class OuterValue; def call; end; end
class InnerValue; def call; end; end
class Base; end
class Outer
  def initialize; @value = OuterValue.new; end
  Child = Class.new(Base) do
    def initialize; @value = InnerValue.new; end
    def run; @value.call; end
    def self.run; @value.call; end
  end
  def run; @value.call; end
end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#Outer.run"), ["a.rb#OuterValue.call"]);
  assert.deepEqual(factoryCalls(graph, "a.rb#Outer.Child.run"), ["a.rb#InnerValue.call"]);
  assert.deepEqual(factoryCalls(graph, "a.rb#Outer.Child.run~2"), []);
});

for (const [label, extra] of Object.entries({
  "shadowed Class": `Class = Object.new`,
  "reopened Class": `class Class; def self.new(parent); Object.new; end; end`,
  "redefined Class.new": `def Class.new(parent); Object.new; end`,
  "modified singleton factory": `Class.define_singleton_method(:new) { |parent| Object.new }`,
  "modified singleton class": `Class.singleton_class.prepend(Unknown)`,
  "reassigned target": `Suite::Child = Object.new`,
  "conflicting target": `module Suite; class Child; def run; end; end; end`,
  "ambiguous factory target": `module Suite; Child = Class.new(Base); end`,
})) test(`ruby class factories: ${label} declines factory edges across files`, () => {
  const graph = factoryGraph({ "a.rb": `class Base; def call; end; end
module Suite
  Child = Class.new(Base) do
    attr_reader :value
    def run; call; end
  end
  def use; Child.new.call; Child.new.run; end
end`, "change.rb": extra });
  assert.deepEqual(factoryCalls(graph, "a.rb#Suite.use"), []);
  assert.deepEqual(factoryCalls(graph, "a.rb#Suite.Child.run"), []);
  assert.ok(!graph.edges.some(edge => edge.source.startsWith("a.rb#Suite.Child") || edge.target.startsWith("a.rb#Suite.Child")), "invalid factory symbols have no incoming or outgoing relation");
  assert.ok(!graph.nodes.some(node => ["a.rb#Suite.run", "a.rb#Suite.value"].includes(node.id)));
});

for (const factory of ["Class.new(parent)", "factory(Base)", "Other.new(Base)", "Class.new(Base, option: true)"]) {
  test(`ruby class factories: unknown ${factory} block never leaks ownership`, () => {
    const graph = factoryGraph({ "a.rb": `class Base; end
class Value; def call; end; end
class Outer
  Child = ${factory} do
    attr_reader :value
    def initialize; @value = Value.new; end
    def run; end
  end
  def use; @value.call; end
end` });
    assert.ok(!graph.nodes.some(node => ["a.rb#Outer.initialize", "a.rb#Outer.run", "a.rb#Outer.value"].includes(node.id)));
    assert.deepEqual(factoryCalls(graph, "a.rb#Outer.use"), []);
  });
}

test("ruby class factories: parent reassignment and lexical Class shadows stop inheritance", () => {
  for (const extra of ["Base = Object.new", "module Suite; Class = Object.new; end", "class Ancestor; Class = Object.new; end\nmodule Suite; include Ancestor; end"]) {
    const graph = factoryGraph({ "a.rb": `class Base; def call; end; end
module Suite
  Child = Class.new(Base) do
    def run; call; end
  end
  def use; Child.new.run; end
end`, "change.rb": extra });
    assert.deepEqual(factoryCalls(graph, "a.rb#Suite.use"), [], extra);
    assert.ok(!graph.edges.some(edge => edge.relation !== "contains" && (edge.source.includes("Suite.Child") || edge.target.includes("Suite.Child"))), extra);
  }
});

test("ruby class factories: nested declarations use the block's lexical namespace", () => {
  const graph = factoryGraph({ "a.rb": `class Base; end
module Suite
  Child = Class.new(Base) do
    class Helper; def call; end; end
    Other = Class.new(Base) do
      def call; end
    end
    def run; Helper.new.call; Other.new.call; end
  end
end` });
  assert.ok(graph.nodes.some(node => node.id === "a.rb#Suite.Helper"));
  assert.ok(graph.nodes.some(node => node.id === "a.rb#Suite.Other"));
  assert.deepEqual(factoryCalls(graph, "a.rb#Suite.Child.run"), ["a.rb#Suite.Helper.call", "a.rb#Suite.Other.call"]);
});

test("ruby class factories: alias mutation and eigenclass redefinition stop the builtin", () => {
  for (const extra of ["factory = Class; factory.define_singleton_method(:new) { |parent| Object.new }", "class << Class; def new(parent); Object.new; end; end"]) {
    const graph = factoryGraph({ "a.rb": `class Base; def call; end; end
Child = Class.new(Base) do
  def run; call; end
end
def use; Child.new.run; end`, "change.rb": extra });
    assert.deepEqual(factoryCalls(graph, "a.rb#use"), [], extra);
    assert.ok(!graph.edges.some(edge => edge.relation !== "contains" && (edge.source.startsWith("a.rb#Child") || edge.target.startsWith("a.rb#Child"))), extra);
  }
});

test("ruby class factories: constructor overrides cannot type new results as subclass instances", () => {
  for (const change of ["def self.new; Object.new; end", ""]) {
    const graph = factoryGraph({ "a.rb": `class Base
  ${change ? "" : "def self.new; Object.new; end"}
end
Child = Class.new(Base) do
  ${change}
  def run; end
end
def use; Child.new.run; end` });
    assert.deepEqual(factoryCalls(graph, "a.rb#use"), []);
  }
  const mutated = factoryGraph({ "a.rb": `class Base; end
Child = Class.new(Base) do
  def run; end
end
Child.define_singleton_method(:new) { Object.new }
def use; Child.new.run; end` });
  assert.deepEqual(factoryCalls(mutated, "a.rb#use"), []);
});

test("ruby class factories: inherited builtin factory overrides and send mutations decline", () => {
  for (const change of ["class Module; def self.new(*); Object.new; end; end", "Class.send(:define_singleton_method, :new) { Object.new }"]) {
    const graph = factoryGraph({ "a.rb": `class Base; end
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end`, "change.rb": change });
    assert.deepEqual(factoryCalls(graph, "a.rb#use"), [], change);
  }
});

test("ruby class factories: receiverless mutation in the block invalidates constructor inference", () => {
  const graph = factoryGraph({ "a.rb": `class Base; end
Child = Class.new(Base) do
  define_singleton_method(:new) { Object.new }
  def run; end
end
def use; Child.new.run; end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#use"), []);
});

test("ruby class factories: invalid blocks withdraw lexically owned dependent definitions", () => {
  for (const mutation of ["def Class.new(parent); Object.new; end", ""]) {
    const graph = factoryGraph({ "a.rb": `class Base; end
${mutation}
module Suite
  Child = Class.new(Base) do
    class Helper; def call; end; end
    Other = Class.new(Base) do
      def call; end
    end
  end
  def use; Helper.new.call; Other.new.call; end
end` });
    assert.deepEqual(factoryCalls(graph, "a.rb#Suite.use"), mutation ? [] : ["a.rb#Suite.Helper.call", "a.rb#Suite.Other.call"]);
    if (mutation) assert.ok(!graph.edges.some(edge => /#Suite\.(Helper|Other)/.test(edge.source) || /#Suite\.(Helper|Other)/.test(edge.target)));
  }
});

test("ruby class factories: bounded local and constant aliases cannot hide factory mutation", () => {
  for (const alias of [
    "factory = Class; other = factory; other.define_singleton_method(:new) { |parent| Object.new }",
    "Factory = Class; Factory.define_singleton_method(:new) { |parent| Object.new }",
    "Factory = Class; Other = Factory; Other.define_singleton_method(:new) { |parent| Object.new }",
  ]) {
    const graph = factoryGraph({ "a.rb": `class Base; end
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end`, "mutation.rb": alias });
    assert.deepEqual(factoryCalls(graph, "a.rb#use"), [], alias);
  }
  const graph = factoryGraph({ "a.rb": `class Base; end
class Unrelated; end
factory = Unrelated; other = factory; other.define_singleton_method(:label) { "label" }
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#use"), ["a.rb#Child.run"]);
});

test("ruby class factories: inherited hooks make newly created class behavior uncertain", () => {
  for (const declaration of [
    "def self.inherited(child); child.define_singleton_method(:new) { Object.new }; end",
    "def inherited(child); end",
  ]) {
    const graph = factoryGraph({ "a.rb": `class Ancestor
  ${declaration}
end
class Base < Ancestor; end
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end` });
    assert.deepEqual(factoryCalls(graph, "a.rb#use"), declaration.startsWith("def self.") ? [] : ["a.rb#Child.run"]);
  }
});

test("ruby class factories: unrelated instance mutations do not invalidate builtin class creation", () => {
  const graph = factoryGraph({ "a.rb": `class Base; end
class Value; end
value = Value.new
value.define_singleton_method(:label) { "label" }
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#use"), ["a.rb#Child.run"]);
});

test("ruby class factories: ordinary reflective instance calls do not imply Class mutation", () => {
  const graph = factoryGraph({ "a.rb": `class Base; end
class Value; end
def reflect(object)
  object.send(:label)
  object.public_send(:label)
end
value = Value.new
value.send(:label)
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#use"), ["a.rb#Child.run"]);
});

test("ruby class factories: competing alias writers retain possible Class exposure", () => {
  const graph = factoryGraph({ "a.rb": `class Base; end
factory = Class
factory = Object.new
other = factory
other.define_singleton_method(:new) { Object.new }
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#use"), []);
});

test("ruby class factories: unresolved external namespace mutations are not builtin exposure", () => {
  const graph = factoryGraph({ "a.rb": `module External; end
External::Client.class_eval do
  def label; end
end
class Base; end
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#use"), ["a.rb#Child.run"]);
});

test("ruby class factories: qualified alias assignments use the resolved namespace", () => {
  for (const target of ["Class", "Unrelated"]) {
    const graph = factoryGraph({ "a.rb": `module Holder; end
class Unrelated; end
module Suite
  Holder::Factory = ${target}
end
Holder::Factory.define_singleton_method(:new) { |parent| Object.new }
class Base; end
Child = Class.new(Base) do
  def run; end
end
def use; Child.new.run; end` });
    assert.deepEqual(factoryCalls(graph, "a.rb#use"), target === "Class" ? [] : ["a.rb#Child.run"]);
  }
});

test("ruby class factories: anonymous stub symbols remain inspectable without guessed callers", () => {
  const graph = factoryGraph({ "spec.rb": `before do
  stub_const("AiUsageLog", Class.new do
    def self.create!(*args); end
  end)
end`, "app.rb": `class SomeModel; end
class OtherModel; end
def run
  SomeModel.create!
  OtherModel.create!
  AiUsageLog.create!
end` });
  const stub = graph.nodes.find(node => node.id === "spec.rb#create!");
  assert.ok(stub, "the existing anonymous stub symbol remains inspectable");
  assert.equal(stub.receiver, "class");
  assert.deepEqual(graph.edges.filter(edge => edge.target === stub.id && edge.relation === "calls"), []);
  assert.deepEqual(factoryCalls(graph, "app.rb#run"), []);
});

test("ruby class factories: ordinary constructor blocks retain their lexical calls", () => {
  const graph = factoryGraph({ "a.rb": `class Builder; end
class Worker
  def helper; end
  def run
    Builder.new do
      helper
    end
  end
end` });
  assert.deepEqual(factoryCalls(graph, "a.rb#Worker.run"), ["a.rb#Worker.helper"]);
});
