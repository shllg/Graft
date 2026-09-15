import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";
async function withGraph(source: string, check: (g: GraphV1) => void, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graft-injection-"));
  try {
    mkdirSync(dirname(join(dir, "app.rb")), { recursive: true });
    writeFileSync(join(dir, "app.rb"), source);
    for (const [path, body] of Object.entries(extra)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    await buildGraph(dir);
    check(readGraph(wiringPath(join(dir, "graft")))!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const targets = (g: GraphV1, source: string) => g.edges.filter(e => e.source === `app.rb#${source}` && ["calls", "dispatches"].includes(e.relation));
const dispatchers = `class Dispatcher; def call; end; end
class NullDispatcher; def call; end; end
class Unrelated; def call; end; end\n`;
test("Ruby keyword defaults expose conditional source bindings, not exclusive calls", async () => {
  await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end`, g => {
    const edges = targets(g, "Service.run");
    assert.deepEqual(edges.map(e => [e.target, e.relation, e.confidence]), [["app.rb#Dispatcher.call", "dispatches", "ruby_injection"]]);
    assert.match(edges[0].via!, /conditional.*dispatcher.*default/i);
  });
});
test("Ruby factory forwards explicit bindings into its exact instance implementation", async () => {
  await withGraph(dispatchers + `class Runtime
 def self.run(dispatcher: NullDispatcher.new); new(dispatcher:).run; end
 def initialize(dispatcher:); @dispatcher = dispatcher; end
 def run; dispatch; end
 def dispatch; @dispatcher.call; end
end
class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; Runtime.run(dispatcher: @dispatcher); end
end`, g => {
    const instance = g.nodes.find(n => n.name === "run" && n.owner === "Runtime" && n.receiver === "instance")!;
    assert.ok(targets(g, "Runtime.run").some(e => e.target === instance.id && e.relation === "calls"));
    const edges = targets(g, "Runtime.dispatch");
    assert.deepEqual(edges.map(e => [e.target, e.relation]), [["app.rb#Dispatcher.call", "dispatches"]]);
    assert.match(edges[0].via!, /Service.initialize.*default/);
    assert.match(edges[0].via!, /Runtime.run.*dispatcher/);
  });
});
for (const [name, change, call] of [
  ["unknown actual", "", "Service.new(dispatcher: unknown)"],
  ["keyword splat", "", "Service.new(**options)"],
  ["reassigned parameter", "dispatcher = unknown;", ""],
  ["multiple ivar writers", "@dispatcher = unknown;", ""],
  ["constant shadow", "", ""],
  ["overridden new", "", ""],
  ["unknown composition", "", ""],
] as const) test(`Ruby injection declines ${name}`, async () => {
  await withGraph(dispatchers + `class Service
 ${name === "constant shadow" ? "Dispatcher = Object.new" : ""}
 ${name === "unknown composition" ? "include External" : ""}
 def initialize(dispatcher: Dispatcher.new); ${change} @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end
${name === "overridden new" ? "class Dispatcher; def self.new; Object.new; end; end" : ""}
${call}`, g => assert.deepEqual(targets(g, "Service.run"), []));
});
test("Ruby class ivars cannot supply instance injection", async () => {
 await withGraph(dispatchers + `class Service
 def self.setup(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end`, g => assert.deepEqual(targets(g, "Service.run"), []));
});
test("Ruby a non-constructor factory return does not acquire the class instance method", async () => {
 await withGraph(`class Runtime
 def self.new; Object.new; end
 def self.run; new.run; end
 def run; end
end`, g => assert.equal(targets(g, "Runtime.run").some(e => g.nodes.find(n => n.id === e.target)?.receiver === "instance"), false));
});
test("Ruby injected ivars remain visible with an annotated Array map contract", async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 # @param items [Array<Object>]
 def run(items); items.map { |item| @dispatcher.call(item) }; end
end`, g => assert.deepEqual(targets(g, "Service.run").map(e => e.target), ["app.rb#Dispatcher.call"]));
});
for (const [name, source] of [
 ["method shadowing", `class Service
 def dispatcher; Dispatcher.new; end
 def initialize; @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end`],
 ["unknown inheritance", `class Service < External
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end`],
 ["block parameter shadowing", `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run(dispatcher: Dispatcher.new); items.each { |dispatcher| dispatcher.call }; end
end`],
 ["self-changing block", `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run(other); other.instance_eval { @dispatcher.call }; end
end`],
 ["arbitrary factory", `class Maker; def self.build; unknown; end; end
class Service
 def initialize(dispatcher: Maker.build); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end`],
 ["forward-all arguments", `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end
class Runner; def self.go(...); Service.new(...); end; end`],
] as const) test(`Ruby injection declines ${name}`, async () => {
 await withGraph(dispatchers + source, g => assert.deepEqual(targets(g, "Service.run"), []));
});
test("Ruby factory construction declines subclass-specific new overrides", async () => {
 await withGraph(`class Runtime
 def self.run; new().run; end
 def run; end
end
class Child < Runtime
 def self.new; Object.new; end
end
Child.run`, g => assert.equal(targets(g, "Runtime.run").some(e => g.nodes.find(n => n.id === e.target)?.receiver === "instance"), false));
});
test("Ruby factory construction declines subclass-specific instance implementations", async () => {
 await withGraph(`class Runtime
 def self.run; new().run; end
 def run; end
end
class Child < Runtime
 def run; end
end
Child.run`, g => assert.deepEqual(targets(g, "Runtime.run"), []));
});
test("Ruby a bare new factory reaches its exact instance implementation", async () => {
 await withGraph(`class Runtime
 def self.run; new.run; end
 def run; end
end`, g => assert.ok(targets(g, "Runtime.run").some(e => g.nodes.find(n => n.id === e.target)?.receiver === "instance")));
});
test("Ruby explicit override names only the supplied dispatcher", async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: NullDispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end
Service.new(dispatcher: Dispatcher.new)`, g => {
   assert.deepEqual(targets(g, "Service.run").map(e => e.target), ["app.rb#Dispatcher.call"]);
   assert.match(targets(g, "Service.run")[0].via!, /argument from app.rb/);
 });
});
test("Ruby lexical constants are resolved at the binding declaration, not its downstream reader", async () => {
 await withGraph(`module Inner
 class Dispatcher; def call; end; end
 class Service
  def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
  def run; @dispatcher.call; end
 end
end
class Dispatcher; def call; end; end`, g => assert.deepEqual(targets(g, "Inner.Service.run").map(e => e.target), ["app.rb#Inner.Dispatcher.call"]));
});
test("Ruby an accessor writer withdraws the injected ivar binding", async () => {
 await withGraph(dispatchers + `class Service
 attr_accessor :dispatcher
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end`, g => assert.deepEqual(targets(g, "Service.run"), []));
});
test("Ruby keyword names cannot collide with the argument table prototype", async () => {
 await withGraph(dispatchers + `class Service
 def initialize(__proto__: NullDispatcher.new); @dispatcher = __proto__; end
 def run; @dispatcher.call; end
end
Service.new(__proto__: Dispatcher.new)`, g => assert.deepEqual(targets(g, "Service.run").map(e => e.target), ["app.rb#Dispatcher.call"]));
});
test("Ruby defaults and explicit overrides retain independent conditional candidates", async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: NullDispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end
Service.new
Service.new(dispatcher: Dispatcher.new)
Service.new(dispatcher: unknown)`, g => {
   const edges = targets(g, "Service.run");
   assert.deepEqual(edges.map(e => e.target).sort(), ["app.rb#Dispatcher.call", "app.rb#NullDispatcher.call"]);
   assert.ok(edges.every(e => e.relation === "dispatches" && e.confidence === "ruby_injection"));
   assert.match(edges.find(e => e.target.endsWith("#NullDispatcher.call"))!.via!, /default at app.rb/);
   assert.match(edges.find(e => e.target.endsWith("#Dispatcher.call"))!.via!, /argument from app.rb/);
 });
});
test("Ruby omitted keyword forwarding cannot escape a shadowing block parameter", async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher:); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end
class Runner
 def go(dispatcher: Dispatcher.new)
  items.each { |dispatcher| Service.new(dispatcher:) }
 end
end`, g => assert.deepEqual(targets(g, "Service.run"), []));
});

const reviewRegressions = [
  {
    "name": "for_parameter",
    "source": "class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def run(dispatcher: Dispatcher.new)\n  for dispatcher in [Other.new]\n   dispatcher.call\n  end\n end\nend\nService.new.run"
  },
  {
    "name": "rescue_parameter",
    "source": "class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def run(dispatcher: Dispatcher.new)\n  begin\n   raise 'fail'\n  rescue => dispatcher\n   dispatcher.call\n  end\n end\nend\nService.new.run"
  },
  {
    "name": "duplicate_initializer",
    "source": "class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end\n def initialize; end\n def run; @dispatcher.call; end\nend\nService.new.run"
  },
  {
    "name": "block_argument_constructor",
    "source": "class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Dispatcher\n def initialize; yield self if block_given?; end\nend\nclass Service\n def initialize(dispatcher: Dispatcher.new { |d| def d.call; puts 'Singleton'; end }); @dispatcher = dispatcher; end\n def run; @dispatcher.call; end\nend\nService.new.run"
  },
  {
    "name": "inherited_new_flow",
    "source": "class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Runtime\n def self.run(dispatcher: Dispatcher.new); new(dispatcher:).run; end\n def initialize(dispatcher:); @dispatcher = dispatcher; end\n def run; @dispatcher.call; end\nend\nclass Child < Runtime\n def self.new(dispatcher:); super(dispatcher: Other.new); end\nend\nChild.run"
  },
  {
    "name": "self_rebinding_block",
    "source": "class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Foreign\n def initialize; @dispatcher = Other.new; end\n def evaluate(&block); instance_exec(&block); end\nend\nclass Service\n def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end\n def run\n  Foreign.new.evaluate { @dispatcher.call }\n end\nend\nService.new.run\n"
  }
];
for (const fixture of reviewRegressions) test(`Ruby reviewed binding eligibility: ${fixture.name}`, async () => {
  await withGraph(fixture.source, g => assert.deepEqual(g.edges.filter(e => e.confidence === "ruby_injection" && e.target === "app.rb#Dispatcher.call"), []));
});
for (const body of [
 'for dispatcher in [Other.new]; dispatcher.call; end',
 'case [Other.new]; in [dispatcher]; dispatcher.call; end',
 '{ dispatcher: Other.new } => { dispatcher: }; dispatcher.call',
 'dispatcher, other = [Other.new, nil]; dispatcher.call',
 'begin; raise; rescue => dispatcher; dispatcher.call; end',
]) test(`Ruby shared writer inventory invalidates ${body.split(';')[0]}`, async () => {
 await withGraph(dispatchers + `class Other; def call; end; end
class Service
 def run(dispatcher: Dispatcher.new); ${body}; end
end`, g => assert.equal(targets(g, 'Service.run').some(e => e.target === 'app.rb#Dispatcher.call'), false));
});
test('Ruby an unsupported constructor block cannot certify a self factory', async () => {
 await withGraph(`class Runtime
 def initialize; yield self; end
 def self.run; new { |runtime| def runtime.run; end }.run; end
 def run; end
end`, g => assert.equal(targets(g, 'Runtime.run').some(e => e.target === 'app.rb#Runtime.run~2'), false));
});
test('Ruby an unsupported constructor block cannot provide initializer defaults', async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; yield self; end
 def run; @dispatcher.call; end
end
Service.new { |service| service.instance_variable_set(:@dispatcher, nil) }.run`, g => assert.deepEqual(targets(g, 'Service.run'), []));
});
test('Ruby invalid dynamic constructors do not revive optional initializer defaults', async () => {
 await withGraph(dispatchers + `class Runtime
 def self.run; new().run; end
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end
class Child < Runtime
 def self.new; super(dispatcher: unknown); end
end
Child.run`, g => assert.deepEqual(targets(g, 'Runtime.run~2'), []));
});

test("Ruby explicit self-rebinding blocks cannot write the lexical instance type", async () => {
 await withGraph("class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def initialize(dispatcher: Dispatcher.new)\n  Object.new.instance_eval { @dispatcher = Dispatcher.new }\n end\n def run; @dispatcher.call; end\nend\nService.new.run", g => assert.deepEqual(targets(g, "Service.run"), []));
});
for (const [name, body, extra] of [
 ['unknown helper', 'items.evaluate { @dispatcher.call }', ''],
 ['known incompatible receiver', 'Foreign.new.map { @dispatcher.call }', 'class Foreign; end'],
 ['indexed map override', 'items.map { @dispatcher.call }', 'class Foreign; def map(&block); instance_exec(&block); end; end'],
 ['indexed first override', 'items.first(1).map { @dispatcher.call }', 'class Foreign; def first(n); self; end; end'],
] as const) test(`Ruby block-self evidence declines ${name}`, async () => {
 await withGraph(dispatchers + extra + `\nclass Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 # @param items [Array<Object>]
 def run(items); ${body}; end
end`, g => assert.deepEqual(targets(g, 'Service.run'), []));
});
test('Ruby an annotated Array map keeps its block contract explicitly conditional', async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 # @param items [Array<Object>]
 def run(items, limit); items.first(limit).map { @dispatcher.call }; end
end`, g => {
  const edges = targets(g, 'Service.run');
  assert.deepEqual(edges.map(e => e.target), ['app.rb#Dispatcher.call']);
  assert.match(edges[0].via!, /conditional.*annotation-derived.*@param items \[Array<Object>\]/);
 });
});
for (const body of ['Other.new => dispatcher', 'Other.new in dispatcher', 'case Other.new; in dispatcher; end'])
test(`Ruby direct pattern binding invalidates ${body}`, async () => {
 await withGraph(dispatchers + `class Other; def call; end; end
class Service
 def run(dispatcher: Dispatcher.new); ${body}; dispatcher.call; end
end`, g => assert.equal(targets(g, 'Service.run').some(e => e.target === 'app.rb#Dispatcher.call'), false));
});
test('Ruby unannotated collection map has no lexical block-self proof', async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run(items, limit); items.first(limit).map { @dispatcher.call }; end
end`, g => assert.deepEqual(targets(g, 'Service.run'), []));
});
for (const [name, annotation, preparation] of [
 ['annotation on a different parameter', '# @param other [Array<Object>]', ''],
 ['reassigned annotated parameter', '# @param items [Array<Object>]', 'items = unknown;'],
 ['nullable contract', '# @param items [Array<Object>, nil]', ''],
] as const) test(`Ruby Array block contract declines ${name}`, async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 ${annotation}
 def run(items); ${preparation} items.map { @dispatcher.call }; end
end`, g => assert.deepEqual(targets(g, 'Service.run'), []));
});
test('Ruby replaced callers cannot supply argument-binding evidence', async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher:); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end
class Runner
 def go; Service.new(dispatcher: Dispatcher.new); end
 def go; end
end`, g => assert.deepEqual(targets(g, 'Service.run'), []));
});
test('Ruby replaced reader methods cannot expose stale injected calls', async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
 def run; end
end`, g => assert.deepEqual(targets(g, 'Service.run'), []));
});
test('Ruby separate self-rebinding blocks cannot share an ordinary ivar type', async () => {
 await withGraph(dispatchers + `class Service
 def seed; Object.new.instance_eval { @dispatcher = Dispatcher.new }; end
 def run; Object.new.instance_eval { @dispatcher.call }; end
end`, g => assert.deepEqual(targets(g, 'Service.run'), []));
});
test('Ruby reopened method definitions across files invalidate obsolete defaults', async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; @dispatcher.call; end
end`, g => assert.deepEqual(targets(g, 'Service.run'), []), {
 'reopen.rb': 'class Service; def initialize; end; end',
 });
});
test('Ruby a literal Array can establish the narrow map block-self contract', async () => {
 await withGraph(dispatchers + `class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; [1].map { @dispatcher.call }; end
end`, g => {
   const edges = targets(g, 'Service.run');
   assert.deepEqual(edges.map(e => e.target), ['app.rb#Dispatcher.call']);
   assert.match(edges[0].via!, /literal Array/);
 });
});

const reviewBoundaryRegressions = [
  {
    "name": "crossfile_for",
    "files": {
      "app.rb": "class Dispatcher; def call; puts 'Dispatcher'; end; def initialize; yield self if block_given?; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end\n def run; replace; @dispatcher.call; end\nend",
      "writer.rb": "class Service\n def replace; for @dispatcher in [Other.new]; end; end\nend\nService.new.run"
    }
  },
  {
    "name": "ordinary_constructor_ivar",
    "files": {
      "app.rb": "class Dispatcher; def call; puts 'Dispatcher'; end; def initialize; yield self if block_given?; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def initialize; @dispatcher = Dispatcher.new { |d| def d.call; puts 'Singleton'; end }; end\n def run; @dispatcher.call; end\nend\nService.new.run"
    }
  },
  {
    "name": "ordinary_constructor_direct",
    "files": {
      "app.rb": "class Dispatcher; def call; puts 'Dispatcher'; end; def initialize; yield self if block_given?; end; end\nclass Other; def call; puts 'Other'; end; end\nDispatcher.new { |d| def d.call; puts 'Singleton'; end }.call"
    }
  },
  {
    "name": "ordinary_constructor_local",
    "files": {
      "app.rb": "class Dispatcher; def call; puts 'Dispatcher'; end; def initialize; yield self if block_given?; end; end\nclass Other; def call; puts 'Other'; end; end\ndef run\n dispatcher = Dispatcher.new { |d| def d.call; puts 'Singleton'; end }\n dispatcher.call\nend\nrun"
    }
  },
  {
    "name": "ordinary_constructor_return",
    "files": {
      "app.rb": "class Dispatcher; def call; puts 'Dispatcher'; end; def initialize; yield self if block_given?; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def dispatcher; Dispatcher.new { |d| def d.call; puts 'Singleton'; end }; end\n def run; dispatcher.call; end\nend\nService.new.run"
    }
  }
];
for (const fixture of reviewBoundaryRegressions) test(`Ruby shared boundary: ${fixture.name}`, async () => {
 const { "app.rb": source, ...extra } = fixture.files;
 await withGraph(source, g => assert.deepEqual(g.edges.filter(e => ["calls", "dispatches"].includes(e.relation) && e.target === "app.rb#Dispatcher.call"), []), extra);
});
for (const [name, body] of [
 ['rescue', 'begin; raise; rescue => @dispatcher; end'],
 ['destructuring', '@dispatcher, ignored = [Other.new, nil]'],
 ['destructured for', 'for @dispatcher, ignored in [[Other.new, nil]]; end'],
 ['operator assignment', '@dispatcher ||= Other.new'],
] as const) test(`Ruby reopened ${name} writer invalidates injection across files`, async () => {
 await withGraph(dispatchers + `class Other; def call; end; end
class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; replace; @dispatcher.call; end
end`, g => assert.equal(targets(g, 'Service.run').some(e => e.target === 'app.rb#Dispatcher.call'), false), {
 'writer.rb': `class Service; def replace; ${body}; end; end`,
 });
});
for (const [entry, body] of [
 ['ivar do', 'def initialize; @dispatcher = Dispatcher.new do |d| def d.call; end; end; end\ndef run; @dispatcher.call; end'],
 ['local do', 'def run; dispatcher = Dispatcher.new do |d| def d.call; end; end; dispatcher.call; end'],
 ['direct do', 'def run; Dispatcher.new do |d| def d.call; end; end.call; end'],
 ['return do', 'def dispatcher; Dispatcher.new do |d| def d.call; end; end; end\ndef run; dispatcher.call; end'],
 ['ivar forwarded', 'def initialize(&block); @dispatcher = Dispatcher.new(&block); end\ndef run; @dispatcher.call; end'],
 ['local forwarded', 'def run(&block); dispatcher = Dispatcher.new(&block); dispatcher.call; end'],
 ['direct forwarded', 'def run(&block); Dispatcher.new(&block).call; end'],
 ['return forwarded', 'def dispatcher(&block); Dispatcher.new(&block); end\ndef run(&block); dispatcher(&block).call; end'],
] as const) test(`Ruby constructor blocks decline through ${entry}`, async () => {
 await withGraph(dispatchers + `class Service\n${body}\nend`, g => assert.equal(
  g.edges.some(e => ['calls', 'dispatches'].includes(e.relation) && e.target === 'app.rb#Dispatcher.call'), false));
});
for (const [entry, body] of [
 ['ivar', 'def initialize(...); @dispatcher = Dispatcher.new(...); end\ndef run; @dispatcher.call; end'],
 ['local', 'def run(...); dispatcher = Dispatcher.new(...); dispatcher.call; end'],
 ['direct', 'def run(...); Dispatcher.new(...).call; end'],
 ['return', 'def dispatcher(...); Dispatcher.new(...); end\ndef run(...); dispatcher(...).call; end'],
] as const) test(`Ruby ellipsis forwards constructor blocks through ${entry}`, async () => {
 await withGraph(dispatchers + `class Service\n${body}\nend`, g => assert.equal(
  g.edges.some(e => ['calls', 'dispatches'].includes(e.relation) && e.target === 'app.rb#Dispatcher.call'), false));
});

const recursiveTargetRegressions = [
  {
    "name": "splat_assignment",
    "source": "class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def run(dispatcher: Dispatcher.new); *dispatcher = [Other.new]; dispatcher.call; end\nend\nService.new.run"
  },
  {
    "name": "nested_destructure",
    "source": "class Dispatcher; def call; puts 'Dispatcher'; end; end\nclass Other; def call; puts 'Other'; end; end\nclass Service\n def run(dispatcher: Dispatcher.new); (dispatcher, ignored), rest = [[Other.new, nil], nil]; dispatcher.call; end\nend\nService.new.run"
  }
];
for (const fixture of recursiveTargetRegressions) test(`Ruby recursive target: ${fixture.name}`, async () => {
 await withGraph(fixture.source, g => assert.deepEqual(targets(g, "Service.run").filter(e => e.target === "app.rb#Dispatcher.call"), []));
});
for (const assignment of [
 '*dispatcher = [Other.new]',
 '(dispatcher, ignored), rest = [[Other.new, nil], nil]',
 '((head, *dispatcher), tail), *rest = [[[nil, Other.new], nil]]',
 'head, *dispatcher, tail = [nil, Other.new, nil]',
]) test(`Ruby nested/rest target invalidates ${assignment}`, async () => {
 await withGraph(dispatchers + `class Other; def call; end; end
class Service
 def run(dispatcher: Dispatcher.new); ${assignment}; dispatcher.call; end
end`, g => assert.equal(targets(g, 'Service.run').some(e => e.target === 'app.rb#Dispatcher.call'), false));
});
for (const assignment of [
 '*@dispatcher = [Other.new]',
 '(@dispatcher, ignored), rest = [[Other.new, nil], nil]',
 '((@dispatcher, ignored), *rest), tail = [[[Other.new, nil], nil], nil]',
 'head, *@dispatcher, tail = [nil, Other.new, nil]',
]) test(`Ruby reopened nested/rest ivar target invalidates ${assignment}`, async () => {
 await withGraph(dispatchers + `class Other; def call; end; end
class Service
 def initialize(dispatcher: Dispatcher.new); @dispatcher = dispatcher; end
 def run; replace; @dispatcher.call; end
end`, g => assert.equal(targets(g, 'Service.run').some(e => e.target === 'app.rb#Dispatcher.call'), false), {
 'writer.rb': `class Service; def replace; ${assignment}; end; end`,
 });
});
for (const pattern of ['[*dispatcher]', '{**dispatcher}'])
test(`Ruby pattern rest target invalidates ${pattern}`, async () => {
 await withGraph(dispatchers + `class Service
 def run(data, dispatcher: Dispatcher.new); case data; in ${pattern}; dispatcher.call; end; end
end`, g => assert.equal(targets(g, 'Service.run').some(e => e.target === 'app.rb#Dispatcher.call'), false));
});
test('Ruby nested formal rest parameters cannot become accessor receivers', async () => {
 await withGraph(dispatchers + `class Service
 def dispatcher; Dispatcher.new; end
 def run((head, *dispatcher)); dispatcher.call; end
end`, g => assert.equal(targets(g, 'Service.run').some(e => e.target === 'app.rb#Dispatcher.call'), false));
});
for (const assignment of [
 '(sink.dispatcher, ignored), *rest = [[Other.new, nil]]',
 '*sink.dispatcher = [Other.new]',
 '(values[dispatcher], ignored), *rest = [[Other.new, nil]]',
 '(Other::VALUE, ignored), *rest = [[nil, nil]]',
 'head, * = [nil, Other.new]',
]) test(`Ruby nonvariable assignment target preserves dispatcher: ${assignment}`, async () => {
 await withGraph(dispatchers + `class Other; def call; end; end
class Sink; attr_writer :dispatcher; end
class Service
 def run(dispatcher: Dispatcher.new)
  sink = Sink.new
  values = {}
  ${assignment}
  dispatcher.call
 end
end`, g => assert.ok(targets(g, 'Service.run').some(e => e.target === 'app.rb#Dispatcher.call')));
});
