/**
 * M3b — Ruby dispatch: which of two same-named methods a call actually reaches.
 *
 * M3 typed the receiver and stopped emitting an edge when nothing named its class.
 * That removed the wrong-NAME edges. It did not remove the wrong-TARGET ones,
 * because a typed receiver still resolved through an index that filed `def fire`
 * and `def self.fire` under the same key, walked a class's ancestors in the wrong
 * order, and read a binding table with no notion of where the assignment was.
 *
 * Every expectation below was taken from a running Ruby 3.4 / ActiveRecord 8.1,
 * not from reading the manual. The file is deliberately organized by what the
 * wrong answer WAS, because each one was a `type_bound` edge — the confidence
 * value that tells a reader "a type chose this", which is exactly the claim that
 * has to be true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, EdgeV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-dispatch-"));
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  await buildGraph(dir);
  return { dir, graph: readGraph(wiringPath(join(dir, "graft")))! };
}

const withGraph = async (files: Record<string, string>, body: (g: GraphV1) => void): Promise<void> => {
  const { dir, graph } = await buildAndRead(files);
  try {
    body(graph);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const callTargets = (g: GraphV1, source: string): string[] =>
  g.edges.filter((e: EdgeV1) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();

const heritage = (g: GraphV1, source: string): string[] =>
  g.edges.filter((e: EdgeV1) => e.relation === "extends" && e.source === source).map((e) => e.target).sort();

const refs = (g: GraphV1, source: string): string[] =>
  g.edges.filter((e: EdgeV1) => e.relation === "references" && e.source === source).map((e) => e.target).sort();

const RAILS = {
  "Gemfile": `source "https://rubygems.org"\ngem "rails", "~> 7.1"\n`,
  "config/application.rb": `require "rails/all"\nmodule Dummy\n  class Application < Rails::Application; end\nend\n`,
};

// ── the class object is not an instance ───────────────────────────────────────

test("ruby dispatch: a class-object receiver reaches the INHERITED class method, not the same-named instance method", async () => {
  // Oracle: `Child.fire` => "Parent.fire". Ruby looks the name up on Child's
  // SINGLETON class, whose chain is Child's own `def self.` methods then Parent's.
  // `Child#fire` is never a candidate.
  const files = {
    "parent.rb": `class Parent\n  def self.fire; end\nend\n`,
    "child.rb": `class Child < Parent\n  def fire; end\nend\n`,
    "runner.rb": `class Runner\n  def go\n    Child.fire\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "runner.rb#Runner.go"), ["parent.rb#Parent.fire"]);
  });
});

test("ruby dispatch: `extend` supplies the class method and `include` does not", async () => {
  // Oracle: Svc.dispatch => "ClassSide", Svc.new.dispatch => "InstanceSide".
  const files = {
    "sides.rb": `module InstanceSide\n  def dispatch; end\nend\n\nmodule ClassSide\n  def dispatch; end\nend\n`,
    "svc.rb": `class Svc\n  include InstanceSide\n  extend ClassSide\nend\n`,
    "runner.rb": `class Runner\n  def klass\n    Svc.dispatch\n  end\n\n  def inst\n    Svc.new.dispatch\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "runner.rb#Runner.klass"), ["sides.rb#ClassSide.dispatch"]);
    assert.deepEqual(callTargets(g, "runner.rb#Runner.inst"), ["sides.rb#InstanceSide.dispatch"]);
  });
});

test("ruby dispatch: `class << self` defines class methods, not instance methods", async () => {
  const files = {
    "box.rb": `class Box\n  class << self\n    def open; end\n  end\nend\n`,
    "runner.rb": `class Runner\n  def klass\n    Box.open\n  end\n\n  def inst\n    Box.new.open\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "runner.rb#Runner.klass"), ["box.rb#Box.open"]);
    // Ruby raises NoMethodError here — there is no instance method `open`.
    assert.deepEqual(callTargets(g, "runner.rb#Runner.inst"), []);
  });
});

test("ruby dispatch: a concern's `class_methods do` block is reachable from the class, not from an instance", async () => {
  const files = {
    ...RAILS,
    "app/models/concerns/archivable.rb": `module Archivable\n  extend ActiveSupport::Concern\n\n  class_methods do\n    def archive_all; end\n  end\nend\n`,
    "app/models/doc.rb": `class Doc < ApplicationRecord\n  include Archivable\nend\n`,
    "app/services/runner.rb": `class Runner\n  def klass\n    Doc.archive_all\n  end\n\n  def inst\n    Doc.new.archive_all\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    // Filed under the module Rails actually builds and extends — the same place a
    // hand-written `module ClassMethods` inside a concern already lands.
    assert.deepEqual(callTargets(g, "app/services/runner.rb#Runner.klass"),
      ["app/models/concerns/archivable.rb#Archivable.ClassMethods.archive_all"]);
    assert.deepEqual(callTargets(g, "app/services/runner.rb#Runner.inst"), []);
  });
});

test("ruby dispatch: a has_many collection forwards class methods and scopes, never instance methods", async () => {
  // Oracle (ActiveRecord 8.1): b.posts.publish => NoMethodError on
  // CollectionProxy; b.posts.publish_all => "Post.publish_all"; b.posts.recent
  // => an AssociationRelation, i.e. the scope IS reachable.
  const files = {
    ...RAILS,
    "app/models/blog.rb": `class Blog < ApplicationRecord\n  has_many :posts\nend\n`,
    "app/models/post.rb": `class Post < ApplicationRecord\n  scope :recent, -> { order(id: :desc) }\n  def publish; end\n  def self.publish_all; end\nend\n`,
    "app/services/pub.rb": `class Pub\n  def instance_method_on_proxy\n    Blog.new.posts.publish\n  end\n\n  def class_method_on_proxy\n    Blog.new.posts.publish_all\n  end\n\n  def scope_on_proxy\n    Blog.new.posts.recent\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    // `Blog#posts` is a real call in all three — it is the step that produces the
    // proxy. Only what is called ON the proxy differs.
    const proxy = "app/models/blog.rb#Blog.posts";
    assert.deepEqual(callTargets(g, "app/services/pub.rb#Pub.instance_method_on_proxy"), [proxy]);
    assert.deepEqual(callTargets(g, "app/services/pub.rb#Pub.class_method_on_proxy"),
      [proxy, "app/models/post.rb#Post.publish_all"].sort());
    assert.deepEqual(callTargets(g, "app/services/pub.rb#Pub.scope_on_proxy"),
      [proxy, "app/models/post.rb#Post.recent"].sort());
  });
});

test("ruby dispatch: a belongs_to reader is an instance, so instance methods stay reachable", async () => {
  const files = {
    ...RAILS,
    "app/models/post.rb": `class Post < ApplicationRecord\n  belongs_to :blog\nend\n`,
    "app/models/blog.rb": `class Blog < ApplicationRecord\n  def publish; end\nend\n`,
    "app/services/pub.rb": `class Pub\n  def go\n    Post.new.blog.publish\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/services/pub.rb#Pub.go"),
      ["app/models/blog.rb#Blog.publish", "app/models/post.rb#Post.blog"]);
  });
});

// ── bindings have a position and a boundary ───────────────────────────────────

test("ruby bindings: a call BEFORE the assignment is a method call, not the assigned type", async () => {
  // Ruby's parser turns `x` into a local the moment it reads `x =`. Above that
  // line `x` is still a method call — verified: the first `x.ping` dispatches
  // through `Holder#x`, which returns a Gadget, and only the second is a UserX.
  const files = {
    "types.rb": `class Gadget\n  def ping; end\nend\n\nclass UserX\n  def ping; end\nend\n`,
    "holder.rb": `class Holder\n  def x\n    Gadget.new\n  end\n\n  def run\n    x.ping\n    x = UserX.new\n    x.ping\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "holder.rb#Holder.run"),
      ["holder.rb#Holder.x", "types.rb#Gadget.ping", "types.rb#UserX.ping"]);
  });
});

test("ruby bindings: a class-body local is not visible inside a def", async () => {
  // Oracle: `defined?(y)` inside the def is nil.
  const files = {
    "types.rb": `class UserX\n  def ping; end\nend\n`,
    "leaky.rb": `class Leaky\n  y = UserX.new\n\n  def probe\n    y.ping\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "leaky.rb#Leaky.probe"), []);
  });
});

test("ruby bindings: a class-body @ivar belongs to the class object, not to instances", async () => {
  // Oracle: the instance's @x is nil; the class object's @x is a UserX.
  const files = {
    "types.rb": `class UserX\n  def ping; end\nend\n`,
    "leak.rb": `class IvarLeak\n  @x = UserX.new\n\n  def probe\n    @x.ping\n  end\n\n  def self.probe\n    @x.ping\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "leak.rb#IvarLeak.probe"), []);
  });
});

// ── the finder vocabulary is ActiveRecord's, and it reads its arguments ────────

test("ruby typing: the finder vocabulary does not apply to a plain Ruby class", async () => {
  const files = {
    "widget.rb": `class Widget\n  def self.first\n    Gadget.new\n  end\n  def ping; end\nend\n`,
    "gadget.rb": `class Gadget\n  def ping; end\nend\n`,
    "runner.rb": `class Runner\n  def go\n    Widget.first.ping\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    // `Widget.first` is a hand-written class method whose body returns a Gadget.
    // Nothing in the Rails vocabulary applies, and the declared return type of a
    // plain `def self.first` is followed only when the method inference can read
    // it — which it can here.
    assert.deepEqual(callTargets(g, "runner.rb#Runner.go").filter((t) => t.endsWith("ping")), ["gadget.rb#Gadget.ping"]);
  });
});

test("ruby typing: a finder given a count or a list returns an Array, not a record", async () => {
  // Oracle (ActiveRecord 8.1): User.first(2), User.last(2), User.take(2),
  // User.find([1,2]), User.find(1,2) and User.create!([...]) are all Arrays.
  const files = {
    ...RAILS,
    "app/models/user.rb": `class User < ApplicationRecord\n  def ping; end\nend\n`,
    "app/services/runner.rb": `class Runner\n  def many\n    User.first(2).ping\n  end\n\n  def listed\n    User.find([1, 2]).ping\n  end\n\n  def several\n    User.find(1, 2).ping\n  end\n\n  def one\n    User.find(1).ping\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/services/runner.rb#Runner.many"), []);
    assert.deepEqual(callTargets(g, "app/services/runner.rb#Runner.listed"), []);
    assert.deepEqual(callTargets(g, "app/services/runner.rb#Runner.several"), []);
    assert.deepEqual(callTargets(g, "app/services/runner.rb#Runner.one"), ["app/models/user.rb#User.ping"]);
  });
});

// ── a rescue or else clause is a result path ──────────────────────────────────

test("ruby returns: a rescue clause that yields another class withdraws the return type", async () => {
  // Oracle: `begin; raise; UserX.new; rescue; Gadget.new; end` is a Gadget.
  const files = {
    "types.rb": `class Gadget\n  def ping; end\nend\n\nclass UserX\n  def ping; end\nend\n`,
    "maker.rb": `class Maker\n  def build\n    UserX.new\n  rescue StandardError\n    Gadget.new\n  end\n\n  def go\n    build.ping\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "maker.rb#Maker.go").filter((t) => t.endsWith("ping")), []);
  });
});

test("ruby returns: an else clause is the value when nothing raised", async () => {
  // Oracle: `begin; UserX.new; rescue; UserX.new; else; Gadget.new; end` is a Gadget.
  const files = {
    "types.rb": `class Gadget\n  def ping; end\nend\n\nclass UserX\n  def ping; end\nend\n`,
    "maker.rb": `class Maker\n  def build\n    begin\n      UserX.new\n    rescue StandardError\n      UserX.new\n    else\n      Gadget.new\n    end\n  end\n\n  def go\n    build.ping\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "maker.rb#Maker.go").filter((t) => t.endsWith("ping")), []);
  });
});

// ── ancestors, in Ruby's own order ────────────────────────────────────────────

test("ruby ancestors: a module's own includes come before the next sibling module", async () => {
  // Oracle: Host.ancestors => [Host, Near, Deep, Sibling, ...]; Host.new.marker
  // is Deep's.
  const files = {
    "mods.rb": `module Deep\n  def marker; end\nend\n\nmodule Near\n  include Deep\nend\n\nmodule Sibling\n  def marker; end\nend\n`,
    "host.rb": `class Host\n  include Sibling\n  include Near\n\n  def go\n    marker\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "host.rb#Host.go"), ["mods.rb#Deep.marker"]);
  });
});

test("ruby ancestors: a prepended module wins over the class's own method", async () => {
  // Oracle: Service.ancestors => [Override, Service, ...]; Service.new.ping is
  // Override's.
  const files = {
    "override.rb": `module Override\n  def ping; end\nend\n`,
    "service.rb": `class Service\n  prepend Override\n\n  def ping; end\n\n  def go\n    ping\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "service.rb#Service.go"), ["override.rb#Override.ping"]);
  });
});

// ── a shadowed constant stops the search, in heritage too ─────────────────────

test("ruby heritage: an inner constant assignment shadows the top-level module of the same name", async () => {
  const files = {
    "actual.rb": `module Actual\n  def tag; end\nend\n`,
    "scope.rb": `module Scope\n  Actual = Module.new\n\n  class Child\n    include Actual\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    // `Scope::Actual` is the one Ruby includes and it has no node. The top-level
    // `Actual` is a different module and must not be named.
    assert.deepEqual(heritage(g, "scope.rb#Scope.Child"), []);
  });
});

// ── Rails association targets ─────────────────────────────────────────────────

test("rails associations: a through/source pair follows the source reflection's class_name", async () => {
  // Oracle (ActiveRecord 8.1): Team#people is a collection of User, because the
  // `person` reflection on Membership declares class_name: "User".
  const files = {
    ...RAILS,
    "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
    "app/models/person.rb": `class Person < ApplicationRecord\nend\n`,
    "app/models/membership.rb": `class Membership < ApplicationRecord\n  belongs_to :person, class_name: "User"\nend\n`,
    "app/models/team.rb": `class Team < ApplicationRecord\n  has_many :memberships\n  has_many :people, through: :memberships, source: :person\nend\n`,
  };
  await withGraph(files, (g) => {
    const t = refs(g, "app/models/team.rb#Team");
    assert.ok(!t.includes("app/models/person.rb#Person"), `must not name Person: ${t.join(", ")}`);
  });
});

test("rails associations: the target is looked up in the model's namespace, not its lexical nesting", async () => {
  // Oracle (ActiveRecord 8.1): Admin::Post.reflect_on_association(:user).klass
  // is Admin::User. Ruby's own lexical lookup for the compact `class Admin::Post`
  // would find ::User instead — Rails walks the model's namespace, which Ruby does not.
  const files = {
    ...RAILS,
    "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
    "app/models/admin/user.rb": `module Admin\n  class User < ApplicationRecord\n  end\nend\n`,
    "app/models/admin/post.rb": `class Admin::Post < ApplicationRecord\n  belongs_to :user\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(refs(g, "app/models/admin/post.rb#Admin.Post"), ["app/models/admin/user.rb#Admin.User"]);
  });
});

// ── the two places Rails moves a call off the chain it looks like ─────────────

test("rails: ActiveSupport::CurrentAttributes forwards a class call to the instance", async () => {
  // Oracle (ActiveSupport 8.1): `Cur.system_admin?` reaches `def system_admin?`.
  // CurrentAttributes defines `method_missing` to `instance.public_send`, so the
  // class object answers the INSTANCE chain — the one construct in Rails where it
  // does, and `Current.*` is among the most-called receivers in a Rails app.
  const files = {
    ...RAILS,
    "app/models/current.rb": `
class Current < ActiveSupport::CurrentAttributes
  attribute :user

  def system_admin?
  end
end
`,
    "app/services/guard.rb": `class Guard\n  def check\n    Current.system_admin?\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/services/guard.rb#Guard.check"),
      ["app/models/current.rb#Current.system_admin?"]);
  });
});

test("rails: an ordinary class does NOT forward a class call to its instance methods", async () => {
  // The control for the test above: without the CurrentAttributes superclass, Ruby
  // raises NoMethodError and the graph must say nothing.
  const files = {
    ...RAILS,
    "app/models/plain.rb": `class Plain\n  def system_admin?\n  end\nend\n`,
    "app/services/guard.rb": `class Guard\n  def check\n    Plain.system_admin?\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/services/guard.rb#Guard.check"), []);
  });
});

test("ruby bindings: a scope lambda's parameter is a local, not a call on the model", async () => {
  // `scope :for_user, ->(user) { where(user: user) }` — the lambda's own parameter
  // shadows the association reader of the same name. extract.ts pushes a scope
  // segment for the lambda body that the binding walk does not, so the lookup has
  // to walk out of it; a `def` is the only thing that may stop that walk.
  const files = {
    ...RAILS,
    "app/models/audit_log.rb": `
class AuditLog < ApplicationRecord
  belongs_to :user

  scope :for_user, ->(user) { where(user: user) }
end
`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/models/audit_log.rb#AuditLog.for_user"), []);
  });
});

test("ruby bindings: two writers that agree on the class agree, however each was read", async () => {
  // `@config = Config.find(id)` in one action and `@config = Config.new` in another
  // both say "a Config". Requiring them to agree on HOW that was read — one through
  // ActiveRecord's finder vocabulary, one through plain `new` — cost every Rails
  // controller shaped this way its binding.
  const files = {
    ...RAILS,
    "app/models/config.rb": `class Config < ApplicationRecord\n  def touch_it; end\nend\n`,
    "app/controllers/configs_controller.rb": `
class ConfigsController < ApplicationController
  def show
    @config = Config.find(params[:id])
    @config.touch_it
  end

  def new
    @config = Config.new
  end
end
`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/controllers/configs_controller.rb#ConfigsController.show"),
      ["app/models/config.rb#Config.touch_it"]);
  });
});

test("ruby dispatch: a block in a class body has an unknown self, so both chains answer", async () => {
  // minitest's `test "…" do … end` turns its block into an INSTANCE method, so a
  // bare call inside it reaches the suite's instance helpers. `included do … end`
  // runs in the includer's class body, so a bare call there reaches class methods.
  // Identical syntax; the graph may not pick one and call it knowledge.
  const files = {
    "helper.rb": `
class Suite
  def self.klass_helper; end
  def inst_helper; end

  def self.test(name, &blk); end
end
`,
    "suite_test.rb": `
class MySuite < Suite
  test "does a thing" do
    inst_helper
  end

  test "does another" do
    klass_helper
  end
end
`,
  };
  await withGraph(files, (g) => {
    const out = callTargets(g, "suite_test.rb#MySuite");
    assert.ok(out.includes("helper.rb#Suite.inst_helper"), out.join(", "));
    assert.ok(out.includes("helper.rb#Suite.klass_helper"), out.join(", "));
  });
});

test("ruby dispatch: module_function makes a def answer both chains, and only below the line", async () => {
  // Oracle (Ruby 3.4): `D.reject` reaches `def reject` after a bare
  // `module_function`; a `def` written ABOVE the line raises NoMethodError on the
  // module. 112 of dailywerk's service modules are written this way —
  // `Tool::Denials.reject(...)` is an ordinary `def reject` reached through it.
  const files = {
    "denials.rb": `
module Denials
  def early; end

  module_function

  def reject; end
end
`,
    "caller.rb": `class Caller\n  def a\n    Denials.reject\n  end\n\n  def b\n    Denials.early\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "caller.rb#Caller.a"), ["denials.rb#Denials.reject"]);
    assert.deepEqual(callTargets(g, "caller.rb#Caller.b"), []);
  });
});

test("ruby dispatch: `extend self` applies to the whole module, including defs above it", async () => {
  // Oracle: position-independent, unlike `module_function` — Ruby resolves the
  // extension at call time.
  const files = {
    "util.rb": `
module Util
  def before_it; end
  extend self
  def after_it; end
end
`,
    "caller.rb": `class Caller\n  def go\n    Util.before_it\n    Util.after_it\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "caller.rb#Caller.go"), ["util.rb#Util.after_it", "util.rb#Util.before_it"]);
  });
});

test("rails concerns: a scope declared in `included do` is a class method on every includer", async () => {
  // `scope` inside `included do` runs in the INCLUDER, so `Organization.pending`
  // is legal. A hand-written `def self.helper` on the same module is NOT —
  // `include M` never puts `M.helper` on the includer — and both are owned by the
  // module, so only `origin` separates them.
  const files = {
    ...RAILS,
    "app/models/concerns/syncable.rb": `
module Syncable
  extend ActiveSupport::Concern

  included do
    scope :pending, -> { where(status: "pending") }
  end

  def self.helper; end

  class_methods do
    def requiring_sync
      pending
    end

    def sync_all
      requiring_sync
    end
  end
end
`,
    "app/models/org.rb": `class Org < ApplicationRecord\n  include Syncable\nend\n`,
    "app/services/runner.rb": `class Runner\n  def go\n    Org.pending\n  end\n\n  def nope\n    Org.helper\n  end\nend\n`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/services/runner.rb#Runner.go"),
      ["app/models/concerns/syncable.rb#Syncable.pending"]);
    // `include` does not hand over the module's own singleton methods.
    assert.deepEqual(callTargets(g, "app/services/runner.rb#Runner.nope"), []);
    // `self` inside `class_methods do` is the includer CLASS, so the bare call
    // reaches the concern's own scope rather than resolving to nothing.
    assert.deepEqual(callTargets(g, "app/models/concerns/syncable.rb#Syncable.ClassMethods.requiring_sync"),
      ["app/models/concerns/syncable.rb#Syncable.pending"]);
    // …and a sibling in the same block, which Ruby also allows.
    assert.deepEqual(callTargets(g, "app/models/concerns/syncable.rb#Syncable.ClassMethods.sync_all"),
      ["app/models/concerns/syncable.rb#Syncable.ClassMethods.requiring_sync"]);
  });
});
