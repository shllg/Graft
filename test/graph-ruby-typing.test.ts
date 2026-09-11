/**
 * M3 — receiver typing for Ruby.
 *
 * The milestone exists because of one measurement: on filewerk-rails, `graft
 * callers message` returned 161 hits and every one was wrong. `message` was the
 * only node in the repo with that name — a ViewComponent's `attr_reader` — and
 * every `e.message` in every rescue clause in the app landed on it, because an
 * `obj.method` call with an untypeable receiver resolved by bare name.
 *
 * So the property asserted hardest here is the NEGATIVE one. A receiver this pass
 * cannot name produces no edge at all. Not a unique-name guess, not a
 * lower-confidence edge: nothing. Every positive case below is a case where
 * something in the source states the receiver's class — a constant written at the
 * call site, a variable assigned from one, a Rails association, or `self` — and
 * the method is then looked up on that class and its own ancestors, exactly the
 * way Ruby dispatches it.
 *
 * The other invariant: a plain Ruby project gets the same typing (constants,
 * assignments, `self`) and none of the Rails vocabulary, because the Rails
 * vocabulary is gated on a Gemfile, not on directory shape.
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
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-typing-"));
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

const calls = (g: GraphV1, source: string): EdgeV1[] =>
  g.edges.filter((e) => e.relation === "calls" && e.source === source);

/** Targets of the `calls` edges out of `source`, sorted. */
const callTargets = (g: GraphV1, source: string): string[] => calls(g, source).map((e) => e.target).sort();

// ── source 1: a constant written at the call site ──────────────────────────────

test("ruby M3: a constant receiver binds to that class's method, not to a same-named one", async () => {
  // A constant receiver is the CLASS OBJECT, so the method it reaches is the one
  // `def self.` declares. `Journal.post` is the same name on a different class and
  // must not answer; neither must an INSTANCE method named `post`, which is why
  // `Ledger` declares both and only one of them is a legal target here.
  const src = `
class Ledger
  def self.post; end
  def post; end
end

class Journal
  def self.post; end
end

class Runner
  def go
    Ledger.post
  end
end
`;
  await withGraph({ "a.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "a.rb#Runner.go"), ["a.rb#Ledger.post"]);
    assert.equal(calls(g, "a.rb#Runner.go")[0].confidence, "type_bound");
    // `def self.post` is the node this points at, not the instance `def post` that
    // shares its id shape.
    const target = g.nodes.find((n) => n.id === calls(g, "a.rb#Runner.go")[0].target);
    assert.equal(target?.receiver, "class");
  });
});

test("ruby M3: a namespaced constant receiver resolves through Module.nesting", async () => {
  const src = `
module Billing
  class Invoice
    def self.total; end
  end

  class Report
    def run
      Invoice.total
    end
  end
end

class Invoice
  def self.total; end
end
`;
  await withGraph({ "b.rb": src }, (g) => {
    // Ruby's own lookup finds `Billing::Invoice` from inside `Billing`, never the
    // top-level one — the nesting chain is searched before the top level.
    assert.deepEqual(callTargets(g, "b.rb#Billing.Report.run"), ["b.rb#Billing.Invoice.total"]);
  });
});

// ── source 4: ActiveSupport::CurrentAttributes ─────────────────────────────────

test("ruby M3: Current.user binds to the CurrentAttributes declaration, not a same-named method", async () => {
  // The construct behind the original 56 false positives. `attribute :user`
  // declares `Current.user`; three other classes in the app also have a `user`,
  // and under a bare-name match the query could not tell them apart.
  const files = {
    ...RAILS,
    "app/models/current.rb": `
class Current < ActiveSupport::CurrentAttributes
  attribute :user, :organization
end
`,
    "app/services/exporter.rb": `
class Exporter
  attr_reader :user

  def run
    Current.user
  end
end
`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/services/exporter.rb#Exporter.run"), [
      "app/models/current.rb#Current.user",
    ]);
  });
});

test("ruby M3: `Current.user = x` calls the WRITER, and is not a caller of the reader", async () => {
  // Ruby's assignment syntax hides a method call, and tree-sitter parks it in the
  // `left` field of an `assignment` as an ordinary `call` node. Reading it as the
  // reader would report every `Current.user = …` in a Rails app as a caller of a
  // method it never calls.
  const files = {
    ...RAILS,
    "app/models/current.rb": `
class Current < ActiveSupport::CurrentAttributes
  attribute :user
end
`,
    "app/controllers/sessions_controller.rb": `
class SessionsController
  def create
    Current.user = 1
  end

  def show
    Current.user
  end
end
`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/controllers/sessions_controller.rb#SessionsController.create"), [
      "app/models/current.rb#Current.user=",
    ]);
    assert.deepEqual(callTargets(g, "app/controllers/sessions_controller.rb#SessionsController.show"), [
      "app/models/current.rb#Current.user",
    ]);
  });
});

// ── source 3: assignment inference ─────────────────────────────────────────────

test("ruby M3: a variable assigned from a constructor carries that class through the scope", async () => {
  const src = `
class Widget
  def ping; end
end

class Gadget
  def ping; end
end

class Runner
  def go
    w = Widget.new
    w.ping
  end
end
`;
  await withGraph({ "c.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "c.rb#Runner.go"), ["c.rb#Widget.ping"]);
  });
});

test("ruby M3: an instance variable is typed at the class, so another method sees it", async () => {
  const src = `
class Widget
  def ping; end
end

class Runner
  def setup
    @w = Widget.new
  end

  def go
    @w.ping
  end
end
`;
  await withGraph({ "d.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "d.rb#Runner.go"), ["d.rb#Widget.ping"]);
  });
});

test("ruby M3: a variable written with two different classes is bound to neither", async () => {
  // The disagreement has to withdraw the binding whichever assignment the walk saw
  // first, so this is asserted from both orders in one file.
  const src = `
class Widget
  def ping; end
end

class Gadget
  def ping; end
end

class Runner
  def first
    x = Widget.new
    x = Gadget.new
    x.ping
  end

  def second
    y = Gadget.new
    y = Widget.new
    y.ping
  end
end
`;
  await withGraph({ "e.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "e.rb#Runner.first"), []);
    assert.deepEqual(callTargets(g, "e.rb#Runner.second"), []);
  });
});

test("ruby M3: a relation-returning class method does NOT type the variable", async () => {
  // `Document.where(...)` is a relation, not a `Document`. Typing it as one would
  // bind `.each`/`.size` to whatever the model happens to define.
  const src = `
class Document
  def each; end
end

class Runner
  def go
    docs = Document.where(x: 1)
    docs.each
  end
end
`;
  await withGraph({ "f.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "f.rb#Runner.go"), []);
  });
});

// ── source 2: association readers, and the chain walk ──────────────────────────

test("ruby M3: a two-hop chain walks the association reader's declared class", async () => {
  const files = {
    ...RAILS,
    "app/models/blog.rb": `
class Blog < ApplicationRecord
  has_many :posts
end
`,
    "app/models/post.rb": `
class Post < ApplicationRecord
  def self.publish; end
end
`,
    "app/services/publisher.rb": `
class Publisher
  def run
    blog = Blog.new
    blog.posts.publish
  end
end
`,
  };
  await withGraph(files, (g) => {
    const out = callTargets(g, "app/services/publisher.rb#Publisher.run");
    // `blog.posts` is a CollectionProxy, which forwards class methods and scopes to
    // the model and raises NoMethodError for its instance methods — so the target
    // here is `def self.publish`, and an instance `def publish` would resolve to
    // nothing (see graph-ruby-dispatch.test.ts).
    assert.ok(out.includes("app/models/post.rb#Post.publish"), out.join(", "));
    // The intermediate hop is a call in its own right: `blog.posts`.
    assert.ok(out.includes("app/models/blog.rb#Blog.posts"), out.join(", "));
  });
});

test("ruby M3: a three-hop chain ends on a scope declared by the last class", async () => {
  const files = {
    ...RAILS,
    "app/models/author.rb": `
class Author < ApplicationRecord
  has_one :blog
end
`,
    "app/models/blog.rb": `
class Blog < ApplicationRecord
  has_many :posts
end
`,
    "app/models/post.rb": `
class Post < ApplicationRecord
  scope :recent, -> { order(created_at: :desc) }
end
`,
    "app/services/feed.rb": `
class Feed
  def run
    author = Author.new
    author.blog.posts.recent
  end
end
`,
  };
  await withGraph(files, (g) => {
    const out = callTargets(g, "app/services/feed.rb#Feed.run");
    assert.ok(out.includes("app/models/post.rb#Post.recent"), out.join(", "));
  });
});

test("ruby M3: a chain through a step with no declared return type declines", async () => {
  // `settings` is hand-written, so nothing says what it returns. Resolving
  // `theme` against `Account` anyway would name a different class than the code does.
  const files = {
    ...RAILS,
    "app/models/account.rb": `
class Account < ApplicationRecord
  def settings; end
  def theme; end
end
`,
    "app/services/themer.rb": `
class Themer
  def run
    account = Account.new
    account.settings.theme
  end
end
`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/services/themer.rb#Themer.run"), [
      "app/models/account.rb#Account.settings",
    ]);
  });
});

// ── source 5: delegate ─────────────────────────────────────────────────────────

test("ruby M3: `delegate :name, to: :author` forwards to the target class's method", async () => {
  const files = {
    ...RAILS,
    "app/models/author.rb": `
class Author < ApplicationRecord
  def name; end
end
`,
    "app/models/post.rb": `
class Post < ApplicationRecord
  belongs_to :author
  delegate :name, to: :author
end
`,
  };
  await withGraph(files, (g) => {
    assert.deepEqual(callTargets(g, "app/models/post.rb#Post.name"), ["app/models/author.rb#Author.name"]);
  });
});

test("ruby M3: `delegate :name, to: :author, prefix: true` forwards from the PREFIXED method", async () => {
  const files = {
    ...RAILS,
    "app/models/author.rb": `
class Author < ApplicationRecord
  def name; end
end
`,
    "app/models/post.rb": `
class Post < ApplicationRecord
  belongs_to :author
  delegate :name, to: :author, prefix: true
end
`,
  };
  await withGraph(files, (g) => {
    // Rails defines `author_name`, not `name`; the forward has to hang off the
    // method that exists.
    assert.deepEqual(callTargets(g, "app/models/post.rb#Post.author_name"), [
      "app/models/author.rb#Author.name",
    ]);
    assert.equal(g.nodes.some((n) => n.id === "app/models/post.rb#Post.name"), false);
  });
});

// ── method return types ────────────────────────────────────────────────────────

test("ruby M3: a method whose every exit agrees on one class declares that return type", async () => {
  // The shape of `current_user` in a real Rails app, and the receiver of 126 call
  // sites in filewerk-rails: a memoized reader with a conditional body. Nothing
  // declares what it returns, so nothing but this infers it.
  const files = {
    ...RAILS,
    "app/models/user.rb": `
class User < ApplicationRecord
  def can_delete_account?; end
end
`,
    "app/controllers/gdpr_controller.rb": `
class GdprController
  def delete_account
    current_user.can_delete_account?
  end

  def current_user
    return @current_user if defined?(@current_user)

    @current_user = if session[:impersonating_user_id]
      User.find_by(id: session[:impersonating_user_id])
    elsif session[:user_id]
      User.find_by(id: session[:user_id])
    end
  end
end
`,
  };
  await withGraph(files, (g) => {
    const out = callTargets(g, "app/controllers/gdpr_controller.rb#GdprController.delete_account");
    assert.ok(out.includes("app/models/user.rb#User.can_delete_account?"), out.join(", "));
  });
});

test("ruby M3: one unreadable exit withdraws the whole return type", async () => {
  const files = {
    ...RAILS,
    "app/models/user.rb": `
class User < ApplicationRecord
  def touch!; end
end
`,
    "app/controllers/things_controller.rb": `
class ThingsController
  def go
    subject.touch!
  end

  def subject
    return User.new if simple?

    whatever_the_gem_returns
  end
end
`,
  };
  await withGraph(files, (g) => {
    const out = callTargets(g, "app/controllers/things_controller.rb#ThingsController.go");
    assert.equal(out.includes("app/models/user.rb#User.touch!"), false, out.join(", "));
  });
});

test("ruby M3: an inferred return type is not a reference edge", async () => {
  // The type is a fact the resolver needs, not a dependency the file states. The
  // body here never names `User`, so an edge would be inventing one.
  const files = {
    ...RAILS,
    "app/models/user.rb": `class User < ApplicationRecord; end`,
    "app/models/holder.rb": `
class Holder < ApplicationRecord
  def setup
    @u = User.new
  end

  def subject
    @u
  end
end
`,
  };
  await withGraph(files, (g) => {
    const refs = g.edges.filter(
      (e) => e.relation === "references" && e.source === "app/models/holder.rb#Holder.subject",
    );
    assert.deepEqual(refs, []);
  });
});

// ── the residual: no type, no edge ─────────────────────────────────────────────

test("ruby M3: an untypeable receiver emits no edge — the `e.message` case", async () => {
  const src = `
class Flash
  attr_reader :message
end

class Runner
  def go
    begin
      risky
    rescue StandardError => e
      e.message
    end
  end

  def risky; end
end
`;
  await withGraph({ "g.rb": src }, (g) => {
    const into = g.edges.filter((e) => e.relation === "calls" && e.target === "g.rb#Flash.message");
    assert.deepEqual(into, []);
  });
});

test("ruby M3: a parameter receiver, a subscript receiver and a literal receiver all decline", async () => {
  const src = `
class Sink
  def slurp; end
  def fetch; end
  def upcase; end
end

class Runner
  def go(input, params)
    input.slurp
    params[:id].fetch
    "literal".upcase
  end
end
`;
  await withGraph({ "h.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "h.rb#Runner.go"), []);
  });
});

test("ruby M3: a parameter never reads as a call to a same-named accessor on its own class", async () => {
  // filewerk-rails' `BulkActionsService` takes `organization:` and also declares
  // `attr_reader :organization`. Inside `initialize` the word is the parameter;
  // in every other method it is the accessor. Both readings are in this fixture.
  const src = `
class Service
  attr_reader :organization

  def initialize(organization:)
    @organization = organization
  end

  def authorize
    organization.id
  end
end
`;
  await withGraph({ "i.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "i.rb#Service.initialize"), []);
    assert.deepEqual(callTargets(g, "i.rb#Service.authorize"), ["i.rb#Service.organization"]);
  });
});

test("ruby M3: `def user; @user; end` does not collect foreign callers", async () => {
  // The regression fixture the spec names. Four classes declare a `user`; nothing
  // in `Caller` says which one `subject` is, so `subject.user` binds to none of them.
  const src = `
class ExportService
  def user
    @user
  end
end

class DownloadService
  attr_reader :user
end

class SplitService
  attr_reader :user
end

class Caller
  def go(subject)
    subject.user
  end
end
`;
  await withGraph({ "j.rb": src }, (g) => {
    const into = g.edges.filter((e) => e.relation === "calls" && e.target.endsWith(".user"));
    assert.deepEqual(into, []);
  });
});

// ── implicit self, and its one fallback ────────────────────────────────────────

test("ruby M3: a bare word resolves on the class's own ancestry, including a mixin", async () => {
  const src = `
module Helpers
  def helper; end
end

class Runner
  include Helpers

  def go
    helper
  end
end
`;
  await withGraph({ "k.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "k.rb#Runner.go"), ["k.rb#Helpers.helper"]);
  });
});

test("ruby M3: a bare word falls back to a top-level def, never to another class's method", async () => {
  // Ruby's own rule. A top-level `def` is a private method on Object, so a bare
  // word can reach it; a method on an unrelated class it cannot reach at all, and
  // matching one is how a bare `warn` in a Falcon config file became a call into a
  // rake task's logger.
  const src = `
def top_level_helper; end

class Logger
  def warn; end
end

class Runner
  def uses_toplevel
    top_level_helper
  end

  def uses_nothing
    warn
  end
end
`;
  await withGraph({ "l.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "l.rb#Runner.uses_toplevel"), ["l.rb#top_level_helper"]);
    assert.deepEqual(callTargets(g, "l.rb#Runner.uses_nothing"), []);
  });
});

test("ruby M3: an implicit-self word is read in value positions too, not only as a statement", async () => {
  // `old = user` and a hash value are both calls to the accessor. M0-M2 saw
  // neither, because without knowing which names are variables the only safe
  // position was a bare word standing alone.
  const src = `
class Current
  attr_reader :user

  def snapshot
    old = user
    { who: user }
  end
end
`;
  await withGraph({ "m.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "m.rb#Current.snapshot"), ["m.rb#Current.user"]);
  });
});

test("ruby M3: a local read in a value position is NOT a call, even when the class has that name", async () => {
  const src = `
class Current
  attr_reader :user

  def snapshot(user)
    old = user
    { who: user }
  end
end
`;
  await withGraph({ "n.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "n.rb#Current.snapshot"), []);
  });
});

test("ruby M3: a Ruby 3 pattern binding is a local, not a call on the enclosing class", async () => {
  const src = `
class Current
  attr_reader :user

  def go(payload)
    case payload
    in { user: Hash => user }
      user.fetch
    end
  end

  def fetch; end
end
`;
  await withGraph({ "o.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "o.rb#Current.go"), []);
  });
});

test("ruby M3: an ancestor's method is found, and an ambiguous owner is not guessed at", async () => {
  const src = `
class Base
  def run; end
end

class Child < Base
end

class Runner
  def go
    c = Child.new
    c.run
  end
end
`;
  await withGraph({ "p.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "p.rb#Runner.go"), ["p.rb#Base.run"]);
  });
});

// ── the plain-Ruby invariant ───────────────────────────────────────────────────

test("ruby M3: a plain Ruby project types constants and assignments, and no Rails vocabulary", async () => {
  // No Gemfile, so `has_many` is an ordinary call to a method the repo does not
  // define — it declares no reader and types no chain.
  const src = `
class Post
  def self.publish; end
end

class Blog
  has_many :posts

  def go
    Post.publish
  end

  def chain
    self.posts.publish
  end
end
`;
  await withGraph({ "q.rb": src }, (g) => {
    assert.deepEqual(callTargets(g, "q.rb#Blog.go"), ["q.rb#Post.publish"]);
    // `posts` was never declared, so the chain dies at its first hop.
    assert.deepEqual(callTargets(g, "q.rb#Blog.chain"), []);
    assert.equal(g.nodes.some((n) => n.id === "q.rb#Blog.posts"), false);
  });
});

test("ruby M3: every typed call carries the type_bound confidence, and nothing else does", async () => {
  const src = `
class Widget
  def self.ping; end
end

class Runner
  def go
    Widget.ping
  end
end
`;
  await withGraph({ "r.rb": src }, (g) => {
    const typed = g.edges.filter((e) => e.confidence === "type_bound");
    assert.deepEqual(
      typed.map((e) => `${e.source} -> ${e.target}`),
      ["r.rb#Runner.go -> r.rb#Widget.ping"],
    );
  });
});
