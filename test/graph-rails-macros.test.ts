/**
 * Rails' macro DSL is a set of DECLARATIONS, not dynamic magic.
 *
 * `has_many :items` declares an edge. `before_save :normalize` names a method in the
 * same class. `delegate :name, to: :user` is a typed forward. None of it needs
 * inference — it needs a parser that knows the vocabulary, which is why this is a
 * `rubySynthesizedMethods`-style extension of the `attr_accessor` handling rather
 * than a new pipeline stage.
 *
 * The callback row is the one that pays immediately: `before_save :normalize_email`
 * is today a symbol literal that nothing connects to `def normalize_email`, and it is
 * both unambiguous and trivially extractable.
 *
 * Two properties are load-bearing and asserted hardest here:
 *   - a plain Ruby project must be untouched by any of this, and
 *   - a macro whose target cannot be NAMED (`class_name: some_expr`) synthesizes the
 *     reader methods but emits no edge, because a guessed association is a wrong
 *     refactor waiting to happen.
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
  const dir = mkdtempSync(join(tmpdir(), "graft-rails-macro-"));
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

/** The two files that make a directory look like a Rails application. */
const RAILS = {
  "Gemfile": `source "https://rubygems.org"\ngem "rails", "~> 7.1"\n`,
  "config/application.rb": `require "rails/all"\nmodule Dummy\n  class Application < Rails::Application; end\nend\n`,
};

/** Names of the methods synthesized onto `owner`, sorted. */
const synthesized = (g: GraphV1, ownerId: string): string[] =>
  g.nodes
    .filter((n) => n.origin === "synthesized" && n.id.startsWith(`${ownerId}.`))
    .map((n) => n.name)
    .sort();

const edgesFrom = (g: GraphV1, source: string, relation: string): string[] =>
  g.edges.filter((e) => e.source === source && e.relation === relation).map((e) => e.target).sort();

test("rails macros: belongs_to synthesizes the reader set and points at the class", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
      "app/models/post.rb": `class Post < ApplicationRecord\n  belongs_to :user\nend\n`,
    },
    (g) => {
      assert.deepEqual(synthesized(g, "app/models/post.rb#Post"), [
        "build_user", "create_user", "reload_user", "user", "user=",
      ]);
      assert.ok(
        edgesFrom(g, "app/models/post.rb#Post", "references").includes("app/models/user.rb#User"),
        "the association names User",
      );
    },
  );
});

test("rails macros: has_many singularizes to find the class", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/item.rb": `class Item < ApplicationRecord\nend\n`,
      "app/models/order.rb": `class Order < ApplicationRecord\n  has_many :items\nend\n`,
    },
    (g) => {
      assert.deepEqual(synthesized(g, "app/models/order.rb#Order"), ["item_ids", "item_ids=", "items", "items="]);
      assert.ok(edgesFrom(g, "app/models/order.rb#Order", "references").includes("app/models/item.rb#Item"));
    },
  );
});

test("rails macros: a plural that is not a simple +s still resolves", async () => {
  // `people` → `Person`. A naive `chomp("s")` gives `People`, which is not a class,
  // and the association would silently carry no edge.
  await withGraph(
    {
      ...RAILS,
      "app/models/person.rb": `class Person < ApplicationRecord\nend\n`,
      "app/models/team.rb": `class Team < ApplicationRecord\n  has_many :people\nend\n`,
    },
    (g) => {
      assert.deepEqual(synthesized(g, "app/models/team.rb#Team"), ["people", "people=", "person_ids", "person_ids="]);
      assert.ok(edgesFrom(g, "app/models/team.rb#Team", "references").includes("app/models/person.rb#Person"));
    },
  );
});

test("rails macros: class_name: wins over the inflected guess", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
      "app/models/owner.rb": `class Owner < ApplicationRecord\nend\n`,
      "app/models/post.rb": `class Post < ApplicationRecord\n  belongs_to :owner, class_name: "User"\nend\n`,
    },
    (g) => {
      const refs = edgesFrom(g, "app/models/post.rb#Post", "references");
      assert.ok(refs.includes("app/models/user.rb#User"), "explicit class_name wins");
      assert.equal(refs.includes("app/models/owner.rb#Owner"), false, "the inflected guess must not also fire");
      assert.ok(synthesized(g, "app/models/post.rb#Post").includes("build_owner"), "methods keep the ASSOCIATION name");
    },
  );
});

test("rails macros: a class_name that is not a literal synthesizes methods but no edge", async () => {
  // "Do not synthesize what you cannot name." The reader methods are still real —
  // Rails defines them regardless — but the target is a runtime value.
  await withGraph(
    {
      ...RAILS,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
      "app/models/post.rb": `class Post < ApplicationRecord\n  belongs_to :owner, class_name: OWNER_CLASS\nend\n`,
    },
    (g) => {
      assert.ok(synthesized(g, "app/models/post.rb#Post").includes("owner"), "readers still synthesized");
      assert.deepEqual(edgesFrom(g, "app/models/post.rb#Post", "references"), [], "no guessed target");
    },
  );
});

test("rails macros: a callback symbol becomes a call edge to the method it names", async () => {
  // The sleeper win. Nothing connects these today.
  await withGraph(
    {
      ...RAILS,
      "app/models/user.rb":
        `class User < ApplicationRecord\n` +
        `  before_save :normalize_email\n` +
        `  after_create :notify\n` +
        `  validate :check_quota\n\n` +
        `  def normalize_email; end\n` +
        `  def notify; end\n` +
        `  def check_quota; end\n` +
        `end\n`,
    },
    (g) => {
      assert.deepEqual(edgesFrom(g, "app/models/user.rb#User", "calls"), [
        "app/models/user.rb#User.check_quota",
        "app/models/user.rb#User.normalize_email",
        "app/models/user.rb#User.notify",
      ]);
    },
  );
});

test("rails macros: a callback naming a method that does not exist emits nothing", async () => {
  // It may live in a concern this pass cannot see, or be a typo. Either way a
  // fabricated target is worse than none, and it must not crash the build.
  await withGraph(
    {
      ...RAILS,
      "app/models/user.rb": `class User < ApplicationRecord\n  before_save :does_not_exist\nend\n`,
    },
    (g) => {
      assert.deepEqual(edgesFrom(g, "app/models/user.rb#User", "calls"), []);
      const ids = new Set(g.nodes.map((n) => n.id));
      for (const e of g.edges) {
        if (e.relation === "calls") assert.ok(ids.has(e.target), `${e.target} is a real node`);
      }
    },
  );
});

test("rails macros: a callback resolves up the superclass chain", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/application_record.rb": `class ApplicationRecord\n  def touch_audit; end\nend\n`,
      "app/models/user.rb": `class User < ApplicationRecord\n  before_save :touch_audit\nend\n`,
    },
    (g) => {
      assert.deepEqual(edgesFrom(g, "app/models/user.rb#User", "calls"), [
        "app/models/application_record.rb#ApplicationRecord.touch_audit",
      ]);
    },
  );
});

test("rails macros: scope, enum, store_accessor, attribute and delegate", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
      "app/models/post.rb":
        `class Post < ApplicationRecord\n` +
        `  scope :active, -> { where(archived: false) }\n` +
        `  enum status: %i[draft live]\n` +
        `  store_accessor :settings, :theme\n` +
        `  attribute :price, :decimal\n` +
        `  delegate :name, :email, to: :author\n` +
        `end\n`,
    },
    (g) => {
      assert.deepEqual(synthesized(g, "app/models/post.rb#Post"), [
        "active",
        "draft", "draft!", "draft?",
        "email",
        "live", "live!", "live?",
        "name",
        "price", "price=",
        "settings", "settings=",
        "theme", "theme=",
      ]);
    },
  );
});

test("rails macros: the newer `enum :status, [...]` spelling is recognized too", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/post.rb": `class Post < ApplicationRecord\n  enum :status, %i[draft live]\nend\n`,
    },
    (g) => {
      const names = synthesized(g, "app/models/post.rb#Post");
      for (const n of ["draft", "draft!", "draft?", "live", "live!", "live?"]) {
        assert.ok(names.includes(n), `synthesizes ${n}`);
      }
    },
  );
});

test("rails macros: an included-do block's declarations reach every includer", async () => {
  // A concern's `included do` runs in the includer, so a callback declared there is
  // a callback on each including class. The synthesized method nodes stay in the
  // concern's own file — they have no span in the includer's file, and inventing one
  // would break the span invariant graph-quality checks — but the EDGES are
  // re-attributed, which is what a `callers` query actually walks.
  await withGraph(
    {
      ...RAILS,
      "app/models/concerns/auditable.rb":
        `module Auditable\n` +
        `  extend ActiveSupport::Concern\n\n` +
        `  included do\n` +
        `    before_save :stamp_audit\n` +
        `  end\n` +
        `end\n`,
      "app/models/user.rb":
        `class User < ApplicationRecord\n  include Auditable\n\n  def stamp_audit; end\nend\n`,
      "app/models/post.rb":
        `class Post < ApplicationRecord\n  include Auditable\n\n  def stamp_audit; end\nend\n`,
    },
    (g) => {
      assert.deepEqual(edgesFrom(g, "app/models/user.rb#User", "calls"), ["app/models/user.rb#User.stamp_audit"]);
      assert.deepEqual(edgesFrom(g, "app/models/post.rb#Post", "calls"), ["app/models/post.rb#Post.stamp_audit"]);
    },
  );
});

test("rails macros: an included-do callback with no matching method in an includer stays silent", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/concerns/auditable.rb":
        `module Auditable\n  extend ActiveSupport::Concern\n\n  included do\n    before_save :stamp_audit\n  end\nend\n`,
      "app/models/user.rb": `class User < ApplicationRecord\n  include Auditable\n\n  def stamp_audit; end\nend\n`,
      "app/models/post.rb": `class Post < ApplicationRecord\n  include Auditable\nend\n`,
    },
    (g) => {
      assert.deepEqual(edgesFrom(g, "app/models/user.rb#User", "calls"), ["app/models/user.rb#User.stamp_audit"]);
      assert.deepEqual(edgesFrom(g, "app/models/post.rb#Post", "calls"), [], "no method, no edge");
    },
  );
});

test("rails macros: validates points at the attribute when one exists", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/user.rb":
        `class User < ApplicationRecord\n  attribute :email, :string\n  validates :email, presence: true\n  validates :nowhere, presence: true\nend\n`,
    },
    (g) => {
      const refs = edgesFrom(g, "app/models/user.rb#User", "references");
      assert.deepEqual(refs, ["app/models/user.rb#User.email"], "the known attribute only");
    },
  );
});

test("rails macros: a plain Ruby project synthesizes nothing", async () => {
  // No Gemfile, no config/application.rb. `has_many` here is an ordinary method
  // call to something the repo defines, and reading it as ActiveRecord would invent
  // four methods that do not exist.
  await withGraph(
    {
      "lib/order.rb": `class Order\n  has_many :items\n  before_save :normalize\n\n  def normalize; end\nend\n`,
    },
    (g) => {
      assert.deepEqual(g.nodes.filter((n) => n.origin === "synthesized"), []);
      assert.deepEqual(edgesFrom(g, "lib/order.rb#Order", "calls"), [], "no callback edge outside Rails");
    },
  );
});

test("rails macros: a Rails app's non-model Ruby is unaffected by the vocabulary", async () => {
  // The gate is the repo, but the vocabulary still has to be specific: a method
  // genuinely named `scope` or `attribute` on a plain PORO must not synthesize.
  await withGraph(
    {
      ...RAILS,
      "app/services/thing.rb": `class Thing\n  def scope; end\n  def attribute; end\n\n  def run\n    scope\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(g.nodes.filter((n) => n.origin === "synthesized"), []);
    },
  );
});

test("rails macros: a repo that becomes Rails re-parses instead of replaying", async () => {
  // The memo is keyed on the extractor's own code (`extractorStamp`), which hashes
  // graft's modules and therefore cannot see that a `config/application.rb` appeared.
  // Without `ExtractCache.inputs` this build would replay every file's non-Rails
  // parse forever, and the macros would stay invisible until something unrelated
  // happened to change the extractor. Same failure mode the stamp's own doc comment
  // rejects for mtimes: too loose, in the direction that silently serves stale output.
  const dir = mkdtempSync(join(tmpdir(), "graft-rails-becomes-"));
  try {
    mkdirSync(join(dir, "app/models"), { recursive: true });
    writeFileSync(join(dir, "app/models/user.rb"), `class User < ApplicationRecord\nend\n`);
    writeFileSync(
      join(dir, "app/models/post.rb"),
      `class Post < ApplicationRecord\n  belongs_to :user\nend\n`,
    );
    await buildGraph(dir);
    let g = readGraph(wiringPath(join(dir, "graft")))!;
    assert.deepEqual(g.nodes.filter((n) => n.origin === "synthesized"), [], "not Rails yet");

    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "Gemfile"), `source "https://rubygems.org"\ngem "rails"\n`);
    writeFileSync(join(dir, "config/application.rb"), `module Dummy; end\n`);

    const second = await buildGraph(dir);
    assert.equal(second.reused, 0, "the Rails-ness change invalidates the whole memo");
    g = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(
      g.nodes.some((n) => n.origin === "synthesized" && n.id === "app/models/post.rb#Post.build_user"),
      "and the macros are seen on the very next build",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rails macros: a scope's body is walked, not swallowed with the macro", async () => {
  // The regression the eval caught. Consuming `scope` and returning — which the
  // mixin and attr_* branches both do — drops every call inside the lambda. In
  // filewerk-rails that silently cost `Current.system_admin?` two of its callers,
  // because both lived inside a `scope ... -> { }` body.
  await withGraph(
    {
      ...RAILS,
      "app/models/current.rb": `class Current\n  def self.system_admin?; end\nend\n`,
      "app/models/doc.rb":
        `class Doc < ApplicationRecord\n` +
        `  scope :for_org, ->(org) { unscoped.where(organization: org) unless Current.system_admin? }\n` +
        `end\n`,
    },
    (g) => {
      const scopeNode = g.nodes.find((n) => n.id === "app/models/doc.rb#Doc.for_org");
      assert.ok(scopeNode, "the scope is a node");
      assert.equal(scopeNode!.origin, "synthesized");
      assert.ok(
        g.edges.some(
          (e) =>
            e.relation === "calls" &&
            e.source === "app/models/doc.rb#Doc.for_org" &&
            e.target === "app/models/current.rb#Current.system_admin?",
        ),
        "the call inside the scope body survives, attributed to the scope itself",
      );
    },
  );
});

test("rails macros: an association extension block belongs to the proxy, not the model", async () => {
  // Two things have to be true at once, and the first version of this got the second
  // one wrong. The block must not be SWALLOWED — consuming a macro without descending
  // is how `scope` silently dropped every call in its own body. But `def latest`
  // inside `has_many :items do ... end` is defined on the association proxy, so
  // `order.latest` raises NoMethodError while `order.items.latest` works. Minting it
  // as `Order#latest` invents a method the class does not have, and a false method is
  // not inert: `before_save :latest` would then bind to it. So it lands under the
  // generated reader, which is the closest thing the graph has to that proxy.
  await withGraph(
    {
      ...RAILS,
      "app/models/item.rb": `class Item < ApplicationRecord\nend\n`,
      "app/models/order.rb":
        `class Order < ApplicationRecord\n  has_many :items do\n    def latest\n      reorder(:id).first\n    end\n  end\nend\n`,
    },
    (g) => {
      assert.ok(g.nodes.some((n) => n.id === "app/models/order.rb#Order.items" && n.origin === "synthesized"));
      assert.ok(
        g.nodes.some((n) => n.id === "app/models/order.rb#Order.items.latest" && n.origin === "ast"),
        "the def is still a real, hand-written method — under the reader",
      );
      assert.ok(
        !g.nodes.some((n) => n.id === "app/models/order.rb#Order.latest"),
        "and not on the model, where Rails never put it",
      );
    },
  );
});

test("rails macros: an extension-block method cannot absorb a callback", async () => {
  // The consequence the placement exists to prevent, stated as its own test.
  await withGraph(
    {
      ...RAILS,
      "app/models/item.rb": `class Item < ApplicationRecord\nend\n`,
      "app/models/order.rb":
        `class Order < ApplicationRecord\n  before_save :latest\n  has_many :items do\n    def latest; end\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges.filter((e) => e.relation === "calls" && e.source === "app/models/order.rb#Order").map((e) => e.target),
        [],
        "the callback names no method this class has, so it declines",
      );
    },
  );
});

test("rails macros: a synthesized method counts toward ambiguity but never wins across files", async () => {
  // The rule that keeps M2 from becoming a new source of the very hub M3 exists to
  // remove. `delegate :t, to: :helpers` really does declare `t` on the component —
  // but from another file, `I18n.t(...)` and that forwarder are indistinguishable to
  // a bare-name matcher, and on filewerk-rails the forwarder absorbed 177 call edges.
  await withGraph(
    {
      ...RAILS,
      "app/components/base.rb": `class Base\n  delegate :t, to: :helpers\n\n  def render\n    t("hello")\n  end\nend\n`,
      "app/services/greeter.rb": `class Greeter\n  def run\n    I18n.t("hello")\n  end\nend\n`,
    },
    (g) => {
      assert.ok(
        g.edges.some(
          (e) => e.relation === "calls" && e.source === "app/components/base.rb#Base.render" && e.target === "app/components/base.rb#Base.t",
        ),
        "same file: the declaration is right there, so the match is certain",
      );
      assert.deepEqual(
        g.edges.filter((e) => e.relation === "calls" && e.source === "app/services/greeter.rb#Greeter.run").map((e) => e.target),
        [],
        "cross file: I18n.t must not bind to the forwarder",
      );
    },
  );
});

test("rails macros: several declared readers of one name make a bare call ambiguous", async () => {
  // The other half of the same rule, and it is where the precision actually comes
  // from: once `belongs_to :organization` has declared a reader on several models, a
  // bare `organization` genuinely has several possible owners. Saying so drops 60
  // wrong edges on filewerk-rails that a unique-name match used to emit confidently.
  await withGraph(
    {
      ...RAILS,
      "app/models/organization.rb": `class Organization < ApplicationRecord\nend\n`,
      "app/models/doc.rb": `class Doc < ApplicationRecord\n  belongs_to :organization\nend\n`,
      "app/models/tag.rb": `class Tag < ApplicationRecord\n  belongs_to :organization\nend\n`,
      "app/services/audit.rb": `class Audit\n  def run(rec)\n    rec.organization\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges.filter((e) => e.relation === "calls" && e.source === "app/services/audit.rb#Audit.run").map((e) => e.target),
        [],
        "two declared owners and an untyped receiver — M3's question, not M2's",
      );
    },
  );
});

test("rails macros: `attribute` is two different macros and both are read correctly", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/post.rb": `class Post < ApplicationRecord\n  attribute :price, :decimal\nend\n`,
      "app/models/current.rb": `class Current < ActiveSupport::CurrentAttributes\n  attribute :user, :organization, :system_admin\nend\n`,
    },
    (g) => {
      assert.deepEqual(synthesized(g, "app/models/post.rb#Post"), ["price", "price="], "the cast type is not an attribute");
      assert.deepEqual(synthesized(g, "app/models/current.rb#Current"), [
        "organization", "organization=", "system_admin", "system_admin=", "user", "user=",
      ], "CurrentAttributes declares every symbol");
    },
  );
});

test("rails macros: an explicit def wins over the macro that would generate it", async () => {
  // A `def` overrides the generated method — that is why anyone writes one. Beyond
  // being wrong, synthesizing anyway is destructive: the generated node is minted
  // first, takes the base id, and pushes the hand-written method to `name~2`, so
  // every existing reference to it silently moves. Measured on filewerk-rails, where
  // `Current` declares `attribute :organization` and then defines `def organization=`.
  await withGraph(
    {
      ...RAILS,
      "app/models/current.rb":
        `class Current < ActiveSupport::CurrentAttributes\n` +
        `  attribute :user, :organization\n\n` +
        `  def organization=(org)\n    super\n  end\nend\n`,
    },
    (g) => {
      const own = g.nodes.find((n) => n.id === "app/models/current.rb#Current.organization=");
      assert.ok(own, "the hand-written method keeps the base id");
      assert.equal(own!.origin, "ast", "and it is the hand-written one, not the generated one");
      assert.equal(
        g.nodes.some((n) => n.id.includes("organization=~")),
        false,
        "no dedup ordinal, because nothing collided",
      );
      assert.ok(
        g.nodes.some((n) => n.id === "app/models/current.rb#Current.user" && n.origin === "synthesized"),
        "the attribute that is NOT overridden is still synthesized",
      );
    },
  );
});

/*
 * Options that change the ANSWER, not just the detail.
 *
 * Every expectation below was read off a running ActiveRecord 8.1 rather than from
 * the guides — `Post.instance_methods.grep(...)` — because in each case the macro
 * generates a differently-named method, or none, and this was synthesizing the
 * unoptioned name regardless. A synthesized method that Rails does not define is
 * worse than a missing one: it can absorb a callback, and it adds ambiguity that
 * suppresses a real match somewhere else.
 */

test("rails macros: delegate prefix: true names the method after the target", async () => {
  // `delegate :name, to: :user, prefix: true` defines `user_name`, not `name`.
  await withGraph(
    {
      ...RAILS,
      "app/models/post.rb":
        `class Post < ApplicationRecord\n  belongs_to :user\n  delegate :name, to: :user, prefix: true\nend\n`,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
    },
    (g) => {
      const names = synthesized(g, "app/models/post.rb#Post");
      assert.ok(names.includes("user_name"), `expected user_name, got ${names.join(", ")}`);
      assert.ok(!names.includes("name"), "the unprefixed name is not defined on Post");
    },
  );
});

test("rails macros: delegate prefix: :admin names it after the given word", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/post.rb":
        `class Post < ApplicationRecord\n  delegate :name, to: :user, prefix: :admin\nend\n`,
    },
    (g) => {
      assert.ok(synthesized(g, "app/models/post.rb#Post").includes("admin_name"));
    },
  );
});

test("rails macros: store_accessor honours prefix and suffix", async () => {
  // prefix/suffix `true` both mean "use the store column".
  await withGraph(
    {
      ...RAILS,
      "app/models/pref.rb":
        `class Pref < ApplicationRecord\n  store_accessor :settings, :theme, prefix: true\nend\n`,
      "app/models/other.rb":
        `class Other < ApplicationRecord\n  store_accessor :settings, :lang, suffix: true\nend\n`,
    },
    (g) => {
      const pref = synthesized(g, "app/models/pref.rb#Pref");
      assert.ok(pref.includes("settings_theme") && pref.includes("settings_theme="));
      assert.ok(!pref.includes("theme"), "the unprefixed key is not a method");
      assert.ok(synthesized(g, "app/models/other.rb#Other").includes("lang_settings"));
    },
  );
});

test("rails macros: an enum with scopes and instance methods off generates nothing", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/doc.rb":
        `class Doc < ApplicationRecord\n  enum :status, [:draft, :live], scopes: false, instance_methods: false\nend\n`,
    },
    (g) => {
      assert.deepEqual(synthesized(g, "app/models/doc.rb#Doc"), []);
    },
  );
});

test("rails macros: enum scopes: false keeps the predicates and drops the scopes", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/doc.rb": `class Doc < ApplicationRecord\n  enum :status, [:draft], scopes: false\nend\n`,
    },
    (g) => {
      assert.deepEqual(synthesized(g, "app/models/doc.rb#Doc"), ["draft!", "draft?"]);
    },
  );
});

test("rails macros: enum prefix: true renames every generated method", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/doc.rb": `class Doc < ApplicationRecord\n  enum :status, [:draft], prefix: true\nend\n`,
    },
    (g) => {
      assert.deepEqual(synthesized(g, "app/models/doc.rb#Doc"), ["status_draft", "status_draft!", "status_draft?"]);
    },
  );
});

test("rails macros: a polymorphic belongs_to names no class", async () => {
  // `belongs_to :subject, polymorphic: true` has no single target by definition, and
  // was pointing at whatever model happened to be called `Subject`.
  await withGraph(
    {
      ...RAILS,
      "app/models/note.rb": `class Note < ApplicationRecord\n  belongs_to :subject, polymorphic: true\nend\n`,
      "app/models/subject.rb": `class Subject < ApplicationRecord\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges.filter((e) => e.relation === "references" && e.source === "app/models/note.rb#Note"),
        [],
      );
      assert.ok(synthesized(g, "app/models/note.rb#Note").includes("subject"), "the reader still exists");
    },
  );
});

test("rails macros: has_many :through resolves via source:, not via its own name", async () => {
  // `has_many :members, through: :memberships, source: :user` is a collection of
  // `User`. It was resolving to an unrelated `Member` model.
  await withGraph(
    {
      ...RAILS,
      "app/models/team.rb":
        `class Team < ApplicationRecord\n  has_many :memberships\n` +
        `  has_many :members, through: :memberships, source: :user\nend\n`,
      "app/models/member.rb": `class Member < ApplicationRecord\nend\n`,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
      "app/models/membership.rb": `class Membership < ApplicationRecord\n  belongs_to :user\nend\n`,
    },
    (g) => {
      const targets = g.edges
        .filter((e) => e.relation === "references" && e.source === "app/models/team.rb#Team")
        .map((e) => e.target)
        .sort();
      assert.deepEqual(targets, ["app/models/membership.rb#Membership", "app/models/user.rb#User"]);
    },
  );
});

test("rails macros: a bare has_many :through is FOLLOWED to the source reflection", async () => {
  // The recall half of the `through:` rule. Without `source:`, Rails looks for
  // `:users` then `:user` on the through-class — so the answer comes from
  // `Membership`'s own declaration, not from inflecting the plural. Here the two
  // agree; `graph-ruby-dispatch.test.ts` covers the case where they do not.
  await withGraph(
    {
      ...RAILS,
      "app/models/team.rb":
        `class Team < ApplicationRecord\n  has_many :memberships\n  has_many :users, through: :memberships\nend\n`,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
      "app/models/membership.rb": `class Membership < ApplicationRecord\n  belongs_to :user\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges
          .filter((e) => e.relation === "references" && e.source === "app/models/team.rb#Team")
          .map((e) => e.target)
          .sort(),
        ["app/models/membership.rb#Membership", "app/models/user.rb#User"],
      );
    },
  );
});

test("rails macros: a through: whose join model is outside the repo keeps Rails' own default", async () => {
  // The join model is a gem's, so nothing here could have stated a `class_name:`
  // override — and Rails' own fallback IS the inflected name. Declining instead
  // was measured to cost real edges (`has_many :tags, through: :document_tags`
  // among them) to guard a redirect that cannot exist.
  await withGraph(
    {
      ...RAILS,
      "app/models/team.rb":
        `class Team < ApplicationRecord\n  has_many :users, through: :audits\nend\n`,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges
          .filter((e) => e.relation === "references" && e.source === "app/models/team.rb#Team")
          .map((e) => e.target),
        ["app/models/user.rb#User"],
      );
    },
  );
});

test("rails macros: an unreadable :class_name => CONST declines in both hash syntaxes", async () => {
  // The old presence check was a regex for `class_name:` and missed the hashrocket
  // spelling entirely, so this fell through to the inflected `Owner`.
  await withGraph(
    {
      ...RAILS,
      "app/models/thing.rb":
        `class Thing < ApplicationRecord\n  OWNER_CLASS = "Person"\n  belongs_to :owner, :class_name => OWNER_CLASS\nend\n`,
      "app/models/owner.rb": `class Owner < ApplicationRecord\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges.filter((e) => e.relation === "references" && e.target === "app/models/owner.rb#Owner"),
        [],
      );
      assert.ok(synthesized(g, "app/models/thing.rb#Thing").includes("owner"), "the reader still exists");
    },
  );
});

test("rails macros: a callback keeps its class's namespace", async () => {
  // `before_save :stamp` inside `A::User` states its receiver exactly. Resolving it
  // through the bare owner name `User` let it bind to a `stamp` on an unrelated
  // `B::User` — a wrong edge from a declaration that leaves no room for doubt.
  await withGraph(
    {
      ...RAILS,
      "app/models/a/user.rb": `module A\n  class User < ApplicationRecord\n    before_save :stamp\n  end\nend\n`,
      "app/models/b/user.rb": `module B\n  class User < ApplicationRecord\n    def stamp; end\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges.filter((e) => e.relation === "calls" && e.source === "app/models/a/user.rb#A.User"),
        [],
      );
    },
  );
});

test("rails macros: a namespaced callback still finds its own class's method", async () => {
  // The other half: keeping the namespace must not cost the edges that were right.
  await withGraph(
    {
      ...RAILS,
      "app/models/a/user.rb":
        `module A\n  class User < ApplicationRecord\n    before_save :stamp\n\n    def stamp; end\n  end\nend\n`,
      "app/models/b/user.rb": `module B\n  class User < ApplicationRecord\n    def stamp; end\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges
          .filter((e) => e.relation === "calls" && e.source === "app/models/a/user.rb#A.User")
          .map((e) => e.target),
        ["app/models/a/user.rb#A.User.stamp"],
      );
    },
  );
});

test("rails macros: a callback resolves through the class's own Ruby ancestors", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/a/base.rb": `module A\n  class Base < ApplicationRecord\n    def stamp; end\n  end\nend\n`,
      "app/models/a/user.rb": `module A\n  class User < Base\n    before_save :stamp\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges
          .filter((e) => e.relation === "calls" && e.source === "app/models/a/user.rb#A.User")
          .map((e) => e.target),
        ["app/models/a/base.rb#A.Base.stamp"],
      );
    },
  );
});

test("rails macros: an association in `included do` belongs to the includers", async () => {
  // The recorded deviation said callback AND association edges are re-emitted per
  // includer. Only the callbacks were. `belongs_to :user` inside `Owned` is `Post`'s
  // association — `Owned` has no table and never runs it.
  await withGraph(
    {
      ...RAILS,
      "app/models/concerns/owned.rb":
        `module Owned\n  extend ActiveSupport::Concern\n  included do\n    belongs_to :user\n  end\nend\n`,
      "app/models/post.rb": `class Post < ApplicationRecord\n  include Owned\nend\n`,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
    },
    (g) => {
      const refs = g.edges
        .filter((e) => e.relation === "references" && e.target === "app/models/user.rb#User")
        .map((e) => e.source)
        .sort();
      // Both: the includer, because that is the class that gets the association, and
      // the concern, because naming `User` is a fact about its own source text and
      // has to survive the includer cap.
      assert.deepEqual(refs, ["app/models/concerns/owned.rb#Owned", "app/models/post.rb#Post"]);
    },
  );
});

test("rails macros: extending a concern does not run its `included do`", async () => {
  // `extend` never fires the `included` hook, so nothing declared there belongs to
  // the extending class.
  await withGraph(
    {
      ...RAILS,
      "app/models/concerns/owned.rb":
        `module Owned\n  extend ActiveSupport::Concern\n  included do\n    belongs_to :user\n  end\nend\n`,
      "app/models/post.rb": `class Post < ApplicationRecord\n  extend Owned\nend\n`,
      "app/models/user.rb": `class User < ApplicationRecord\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges
          .filter((e) => e.relation === "references" && e.target === "app/models/user.rb#User")
          .map((e) => e.source),
        ["app/models/concerns/owned.rb#Owned"],
        "the concern still names User; the extending class does not get the association",
      );
    },
  );
});
