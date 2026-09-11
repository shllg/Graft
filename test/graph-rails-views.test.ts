/**
 * Rails view conventions — the edges that exist because of where a file is PUT.
 *
 * `DocumentsController#index` renders `app/views/documents/index.html.erb` and
 * neither file names the other. What makes that indexable rather than guessable is
 * that Rails' own view lookup IS a filesystem lookup: the convention names exactly
 * one path, and that path is either there or it is not.
 *
 * So the assertion that matters in most of these tests is a NEGATIVE one. A
 * convention that names a file which does not exist has not found anything, and a
 * convention that cannot name a single file must decline rather than choose. Both
 * halves are load-bearing and both are pinned below.
 *
 * Every rule here was checked against a running ActionView 8.1.3 before it was
 * written. Two of those runs are quoted in the tests they changed, because reading
 * them off the guides would have produced a different — and wrong — implementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { warmContainerGrammars } from "../src/graph/container.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-rails-views-"));
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  await buildGraph(dir);
  return { dir, graph: readGraph(wiringPath(join(dir, "graft")))! };
}

const withGraph = async (files: Record<string, string>, body: (g: GraphV1) => void): Promise<void> => {
  // The container grammar loads asynchronously and `buildGraph` warms it itself;
  // warming here too keeps the first test in the file from paying for it twice.
  await warmContainerGrammars(["erb"]);
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

const rendersFrom = (g: GraphV1, source: string): string[] =>
  g.edges.filter((e) => e.source === source && e.relation === "renders").map((e) => e.target).sort();

const rendersTo = (g: GraphV1, target: string): string[] =>
  g.edges.filter((e) => e.target === target && e.relation === "renders").map((e) => e.source).sort();

const edge = (g: GraphV1, source: string, target: string, relation: string) =>
  g.edges.find((e) => e.source === source && e.target === target && e.relation === relation);

// ---------------------------------------------------------------------------
// controller action → view
// ---------------------------------------------------------------------------

test("rails views: an action renders the template that shares its name", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/documents_controller.rb":
        `class DocumentsController < ApplicationController\n  def index\n    @documents = []\n  end\n\n  def show\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<h1>Documents</h1>\n`,
    },
    (g) => {
      const action = "app/controllers/documents_controller.rb#DocumentsController.index";
      assert.deepEqual(rendersFrom(g, action), ["app/views/documents/index.html.erb"]);
      assert.equal(edge(g, action, "app/views/documents/index.html.erb", "renders")?.confidence, "convention");
      // `show` has no template on disk. Rails would raise `MissingTemplate`; the
      // graph says nothing, which is the same answer in the only form it has.
      assert.deepEqual(rendersFrom(g, "app/controllers/documents_controller.rb#DocumentsController.show"), []);
    },
  );
});

test("rails views: a namespaced controller resolves through its own directory", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/admin/users_controller.rb":
        `module Admin\n  class UsersController < ApplicationController\n    def index\n    end\n  end\nend\n`,
      "app/views/admin/users/index.html.erb": `<h1>Users</h1>\n`,
      // The same action name one namespace over, to prove the prefix is doing work.
      "app/views/users/index.html.erb": `<h1>Public</h1>\n`,
    },
    (g) => {
      assert.deepEqual(
        rendersFrom(g, "app/controllers/admin/users_controller.rb#Admin.UsersController.index"),
        ["app/views/admin/users/index.html.erb"],
      );
    },
  );
});

test("rails views: the prefix comes from the PATH, so an acronym cannot break it", async () => {
  // `APIClientsController.controller_path` is `"api_clients"` — verified against
  // ActionController 8.1.3, and it stays `"api_clients"` even with
  // `inflect.acronym "API"` configured, because Zeitwerk put the file there.
  // Un-inflecting the constant instead would produce `a_p_i_clients`.
  await withGraph(
    {
      ...RAILS,
      "config/initializers/inflections.rb":
        `ActiveSupport::Inflector.inflections do |inflect|\n  inflect.acronym "API"\nend\n`,
      "app/controllers/api_clients_controller.rb":
        `class APIClientsController < ApplicationController\n  def index\n  end\nend\n`,
      "app/views/api_clients/index.html.erb": `<h1>Clients</h1>\n`,
    },
    (g) => {
      assert.deepEqual(
        rendersFrom(g, "app/controllers/api_clients_controller.rb#APIClientsController.index"),
        ["app/views/api_clients/index.html.erb"],
      );
    },
  );
});

test("rails views: an action that renders explicitly does not also claim its own name", async () => {
  // Rails reaches the naming convention only when the action rendered nothing. An
  // `update` that answers `render :edit` has said what it renders, and claiming an
  // `update.html.erb` that happens to exist as well would be a second, wrong edge.
  await withGraph(
    {
      ...RAILS,
      "app/controllers/posts_controller.rb":
        `class PostsController < ApplicationController\n  def update\n    render :edit\n  end\nend\n`,
      "app/views/posts/edit.html.erb": `<h1>Edit</h1>\n`,
      "app/views/posts/update.html.erb": `<h1>Updated</h1>\n`,
    },
    (g) => {
      const action = "app/controllers/posts_controller.rb#PostsController.update";
      assert.deepEqual(rendersFrom(g, action), ["app/views/posts/edit.html.erb"]);
      assert.equal(edge(g, action, "app/views/posts/edit.html.erb", "renders")?.confidence, "extracted");
    },
  );
});

test("rails views: a class method is not an action", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/reports_controller.rb":
        `class ReportsController < ApplicationController\n  def self.index\n  end\nend\n`,
      "app/views/reports/index.html.erb": `<h1>Reports</h1>\n`,
    },
    (g) => {
      assert.deepEqual(rendersTo(g, "app/views/reports/index.html.erb"), []);
    },
  );
});

test("rails views: a plain Ruby project gets none of this", async () => {
  // The same file layout without the two Rails witnesses. `app/views` is a directory
  // name, not a framework.
  await withGraph(
    {
      "app/controllers/documents_controller.rb":
        `class DocumentsController\n  def index\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<h1>Documents</h1>\n`,
    },
    (g) => {
      assert.equal(g.edges.filter((e) => e.relation === "renders").length, 0);
      assert.equal(g.edges.filter((e) => e.confidence === "convention").length, 0);
      // The template is still INDEXED — that is the container tier, not Rails.
      assert.ok(g.nodes.some((n) => n.id === "app/views/documents/index.html.erb"));
    },
  );
});

// ---------------------------------------------------------------------------
// render, in both of its readings
// ---------------------------------------------------------------------------

test("rails views: `render \"a/b\"` is a TEMPLATE from a controller and a PARTIAL from a view", async () => {
  // Verified: `ActionController::Base#_normalize_args("shared/banner")` returns
  // `{template: "shared/banner"}`, while the same string written in a template is
  // ActionView's partial shorthand. One string, two files, and the difference is
  // which side wrote it.
  await withGraph(
    {
      ...RAILS,
      "app/controllers/pages_controller.rb":
        `class PagesController < ApplicationController\n  def show\n    render "shared/banner"\n  end\nend\n`,
      "app/views/shared/banner.html.erb": `<h1>Banner</h1>\n`,
      "app/views/shared/_banner.html.erb": `<p>partial</p>\n`,
      "app/views/pages/index.html.erb": `<%= render "shared/banner" %>\n`,
    },
    (g) => {
      assert.deepEqual(
        rendersFrom(g, "app/controllers/pages_controller.rb#PagesController.show"),
        ["app/views/shared/banner.html.erb"],
      );
      assert.deepEqual(
        rendersFrom(g, "app/views/pages/index.html.erb"),
        ["app/views/shared/_banner.html.erb"],
      );
    },
  );
});

test("rails views: `render partial:` is a partial wherever it is written", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/pages_controller.rb":
        `class PagesController < ApplicationController\n  def show\n    render partial: "shared/banner"\n  end\nend\n`,
      "app/views/shared/banner.html.erb": `<h1>Template</h1>\n`,
      "app/views/shared/_banner.html.erb": `<p>Partial</p>\n`,
    },
    (g) => {
      assert.deepEqual(
        rendersFrom(g, "app/controllers/pages_controller.rb#PagesController.show"),
        ["app/views/shared/_banner.html.erb"],
      );
    },
  );
});

test("rails views: a slash-less partial resolves to a sibling ONLY in a controller's own directory", async () => {
  // The oracle run that changed this design. `<%= render "widget" %>` written inside
  // `app/views/shared/_nav.html.erb`, rendered with the controller's prefix set to
  // `documents`, resolves to `app/views/documents/_widget.html.erb` — NOT to the
  // `_widget` sitting right beside it in `shared/`. A slash-less spec resolves
  // against the rendering CONTROLLER's prefixes, so from `shared/` a static pass
  // cannot know the answer and declines.
  await withGraph(
    {
      ...RAILS,
      "app/controllers/documents_controller.rb":
        `class DocumentsController < ApplicationController\n  def index\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<%= render "row" %>\n`,
      "app/views/documents/_row.html.erb": `<tr></tr>\n`,
      "app/views/documents/_widget.html.erb": `<i>documents</i>\n`,
      "app/views/shared/_nav.html.erb": `<%= render "widget" %>\n`,
      "app/views/shared/_widget.html.erb": `<i>shared</i>\n`,
    },
    (g) => {
      // `documents/` is a controller's own directory, so the sibling wins outright.
      assert.deepEqual(rendersFrom(g, "app/views/documents/index.html.erb"), ["app/views/documents/_row.html.erb"]);
      // `shared/` is nobody's. Declining is the whole point: the tempting answer,
      // `shared/_widget.html.erb`, is a real file and is the wrong one.
      assert.deepEqual(rendersFrom(g, "app/views/shared/_nav.html.erb"), []);
    },
  );
});

test("rails views: `render json:` inside respond_to does not suppress the HTML template", async () => {
  // The commonest shape in a real controller, and the one that caught this rule
  // being too blunt: suppressing the convention on ANY `render` cost four real
  // edges on filewerk, every one of them an `index` exactly like this. The JSON
  // branch renders no template; the HTML branch renders `index.html.erb` by name.
  await withGraph(
    {
      ...RAILS,
      "app/controllers/document_types_controller.rb":
        `class DocumentTypesController < ApplicationController\n` +
        `  def index\n` +
        `    @document_types = DocumentType.all\n` +
        `    respond_to do |format|\n` +
        `      format.html\n` +
        `      format.json { render json: @document_types }\n` +
        `    end\n` +
        `  end\n` +
        `end\n`,
      "app/views/document_types/index.html.erb": `<h1>Types</h1>\n`,
    },
    (g) => {
      assert.deepEqual(
        rendersFrom(g, "app/controllers/document_types_controller.rb#DocumentTypesController.index"),
        ["app/views/document_types/index.html.erb"],
      );
    },
  );
});

test("rails views: a render whose target cannot be named emits nothing", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/documents_controller.rb":
        `class DocumentsController < ApplicationController\n` +
        `  def index\n` +
        `    render @document\n` +          // polymorphic — depends on a runtime class
        `    render "shared/#{name}"\n` +   // interpolated
        `    render json: { ok: true }\n` + // not a template at all
        `    render partial: PARTIAL\n` +   // a constant this pass cannot evaluate
        `  end\n` +
        `end\n`,
      "app/views/documents/index.html.erb": `<h1>x</h1>\n`,
      "app/views/shared/_document.html.erb": `<p>doc</p>\n`,
      "app/views/documents/_document.html.erb": `<p>doc</p>\n`,
    },
    (g) => {
      // Only the naming convention fires. Every explicit render above names its
      // target at runtime, and a guess between the two `_document` partials on disk
      // is exactly the wrong refactor this project exists to prevent.
      assert.deepEqual(
        rendersFrom(g, "app/controllers/documents_controller.rb#DocumentsController.index"),
        [],
        "an action that renders explicitly claims nothing it cannot name",
      );
    },
  );
});

test("rails views: a render naming a template that is not there emits nothing", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/pages_controller.rb":
        `class PagesController < ApplicationController\n  def show\n    render "shared/missing"\n  end\nend\n`,
      "app/views/pages/show.html.erb": `<h1>Show</h1>\n`,
    },
    (g) => {
      assert.deepEqual(rendersFrom(g, "app/controllers/pages_controller.rb#PagesController.show"), []);
      // And nothing dangling was emitted in its place.
      for (const e of g.edges.filter((x) => x.relation === "renders")) {
        assert.ok(g.nodes.some((n) => n.id === e.target), `renders target exists: ${e.target}`);
      }
    },
  );
});

test("rails views: `.json.jbuilder` and `.html.haml` are not claimed", async () => {
  // Rails would serve either one for this action. M4 verified `.html.erb` and only
  // `.html.erb`; naming a format it never resolved would be a convention with no
  // evidence behind it.
  await withGraph(
    {
      ...RAILS,
      "app/controllers/reports_controller.rb":
        `class ReportsController < ApplicationController\n  def index\n  end\nend\n`,
      "app/views/reports/index.json.jbuilder": `json.ok true\n`,
    },
    (g) => {
      assert.deepEqual(rendersFrom(g, "app/controllers/reports_controller.rb#ReportsController.index"), []);
    },
  );
});

// ---------------------------------------------------------------------------
// layouts
// ---------------------------------------------------------------------------

test("rails views: `layout \"admin\"` names its file, and the default is claimed once", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/application_controller.rb": `class ApplicationController < ActionController::Base\nend\n`,
      "app/controllers/admin/base_controller.rb":
        `module Admin\n  class BaseController < ApplicationController\n    layout "admin"\n  end\nend\n`,
      "app/controllers/admin/users_controller.rb":
        `module Admin\n  class UsersController < BaseController\n  end\nend\n`,
      "app/views/layouts/application.html.erb": `<html></html>\n`,
      "app/views/layouts/admin.html.erb": `<html>admin</html>\n`,
    },
    (g) => {
      assert.deepEqual(
        rendersFrom(g, "app/controllers/admin/base_controller.rb#Admin.BaseController"),
        ["app/views/layouts/admin.html.erb"],
      );
      assert.deepEqual(
        rendersFrom(g, "app/controllers/application_controller.rb#ApplicationController"),
        ["app/views/layouts/application.html.erb"],
      );
      // A layout is INHERITED. `Admin::UsersController` uses its parent's, and
      // claiming `application` for it would name the wrong file — the chain is
      // followable through the `extends` edge that is already in the graph.
      assert.deepEqual(rendersFrom(g, "app/controllers/admin/users_controller.rb#Admin.UsersController"), []);
    },
  );
});

test("rails views: a controller that declares a layout does not also get the default", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/application_controller.rb":
        `class ApplicationController < ActionController::Base\n  layout "wide"\nend\n`,
      "app/views/layouts/application.html.erb": `<html></html>\n`,
      "app/views/layouts/wide.html.erb": `<html>wide</html>\n`,
    },
    (g) => {
      assert.deepEqual(
        rendersFrom(g, "app/controllers/application_controller.rb#ApplicationController"),
        ["app/views/layouts/wide.html.erb"],
      );
    },
  );
});

// ---------------------------------------------------------------------------
// what a template may call
// ---------------------------------------------------------------------------

test("rails views: a bare word in a template reaches a helper, and nothing else", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/helpers/application_helper.rb":
        `module ApplicationHelper\n  def status_badge_color(s)\n    "green"\n  end\nend\n`,
      // A top-level `def` of the same shape, in the place they really live. Before
      // M4 a bare word in a template resolved by unique name across the whole repo,
      // and filewerk's 45 Ruby top-level `def`s — 44 of them in `spec/` — include
      // `url_for`, `root_path`, `name` and `metadata`.
      "spec/support/helpers.rb": `def root_path\n  "/"\nend\n`,
      "app/views/documents/index.html.erb":
        `<%= status_badge_color(1) %>\n<a href="<%= root_path %>">home</a>\n`,
    },
    (g) => {
      const from = "app/views/documents/index.html.erb";
      const calls = g.edges.filter((e) => e.source === from && e.relation === "calls").map((e) => e.target);
      assert.deepEqual(calls, ["app/helpers/application_helper.rb#ApplicationHelper.status_badge_color"]);
      assert.equal(
        edge(g, from, "app/helpers/application_helper.rb#ApplicationHelper.status_badge_color", "calls")?.confidence,
        "convention",
      );
      assert.ok(
        !calls.includes("spec/support/helpers.rb#root_path"),
        "a template's `self` is an ActionView::Base — a top-level `def` is not on it",
      );
    },
  );
});

test("rails views: `helper_method` is what makes a controller method callable from a view", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/concerns/authenticatable.rb":
        `module Authenticatable\n` +
        `  extend ActiveSupport::Concern\n\n` +
        `  included do\n    helper_method :current_user\n  end\n\n` +
        `  def current_user\n    @current_user\n  end\n\n` +
        `  def secret_thing\n    42\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<%= current_user %><%= secret_thing %>\n`,
    },
    (g) => {
      const from = "app/views/documents/index.html.erb";
      const calls = g.edges.filter((e) => e.source === from && e.relation === "calls").map((e) => e.target);
      assert.deepEqual(calls, ["app/controllers/concerns/authenticatable.rb#Authenticatable.current_user"]);
      // `secret_thing` is defined right beside it and is NOT exported. A view cannot
      // call it, so neither can the graph.
      assert.ok(!calls.some((t) => t.endsWith("secret_thing")));
    },
  );
});

test("rails views: two helpers defining one name decline rather than choose", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/helpers/a_helper.rb": `module AHelper\n  def badge\n    "a"\n  end\nend\n`,
      "app/helpers/b_helper.rb": `module BHelper\n  def badge\n    "b"\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<%= badge %>\n`,
    },
    (g) => {
      const calls = g.edges.filter(
        (e) => e.source === "app/views/documents/index.html.erb" && e.relation === "calls",
      );
      assert.deepEqual(calls, [], "two possible owners, so no edge");
    },
  );
});

test("rails views: a helper's `def self.` is not on a view's chain", async () => {
  // A view holds an INSTANCE of the view context with the helper module mixed in,
  // so it reaches instance methods and never singleton ones.
  await withGraph(
    {
      ...RAILS,
      "app/helpers/application_helper.rb":
        `module ApplicationHelper\n  def self.badge\n    "x"\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<%= badge %>\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges.filter((e) => e.source === "app/views/documents/index.html.erb" && e.relation === "calls"),
        [],
      );
    },
  );
});

test("rails views: `include_all_helpers = false` turns the helper chain off", async () => {
  await withGraph(
    {
      ...RAILS,
      "config/environments/production.rb":
        `Rails.application.configure do\n  config.action_controller.include_all_helpers = false\nend\n`,
      "app/helpers/application_helper.rb": `module ApplicationHelper\n  def badge\n    "x"\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<%= badge %>\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges.filter((e) => e.source === "app/views/documents/index.html.erb" && e.relation === "calls"),
        [],
        "the app says this helper is not mixed into every view, so it is not",
      );
    },
  );
});

test("rails views: a template's own `def` answers its own bare word", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/helpers/application_helper.rb": `module ApplicationHelper\n  def headline\n    "helper"\n  end\nend\n`,
      "app/views/documents/index.html.erb":
        `<% def headline %>\n<h1>local</h1>\n<% end %>\n<%= headline %>\n`,
    },
    (g) => {
      // Same file, no ambiguity to have — and Ruby would reach the local `def` too.
      assert.deepEqual(
        g.edges
          .filter((e) => e.source === "app/views/documents/index.html.erb" && e.relation === "calls")
          .map((e) => e.target),
        ["app/views/documents/index.html.erb#headline"],
      );
    },
  );
});

// ---------------------------------------------------------------------------
// the instance-variable contract
// ---------------------------------------------------------------------------

test("rails views: one writer of an ivar the template reads is a contract; several are not", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/documents_controller.rb":
        `class DocumentsController < ApplicationController\n` +
        `  def index\n    @documents = Document.all\n  end\n\n` +
        `  def show\n    @document = Document.find(1)\n  end\n\n` +
        `  def edit\n    @document = Document.find(2)\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<%= @documents.size %>\n`,
      "app/views/documents/show.html.erb": `<%= @document.title %>\n`,
      "app/views/documents/edit.html.erb": `<%= @document.title %>\n`,
    },
    (g) => {
      const contract = (source: string, target: string) =>
        g.edges.find((e) => e.source === source && e.target === target && e.relation === "references");
      assert.ok(
        contract(
          "app/controllers/documents_controller.rb#DocumentsController.index",
          "app/views/documents/index.html.erb",
        ),
        "@documents has exactly one writer",
      );
      // `@document` is written by BOTH `show` and `edit`, so which of them
      // `show.html.erb` means has no answer — and picking one would put `edit` in
      // the blast radius of a template it never renders.
      assert.equal(
        contract(
          "app/controllers/documents_controller.rb#DocumentsController.show",
          "app/views/documents/show.html.erb",
        ),
        undefined,
      );
    },
  );
});

test("rails views: a before_action that sets the state a template reads is the writer", async () => {
  // Not a corner case — it is the common shape. `set_organization` is what really
  // supplies `@organization`, and saying `edit` does would name a method that does
  // not assign it.
  await withGraph(
    {
      ...RAILS,
      "app/controllers/organizations_controller.rb":
        `class OrganizationsController < ApplicationController\n` +
        `  before_action :set_organization\n\n` +
        `  def edit\n  end\n\n` +
        `  private\n\n` +
        `  def set_organization\n    @organization = Organization.find(1)\n  end\nend\n`,
      "app/views/organizations/edit.html.erb": `<%= @organization.name %>\n`,
    },
    (g) => {
      assert.ok(
        g.edges.find(
          (e) =>
            e.source === "app/controllers/organizations_controller.rb#OrganizationsController.set_organization" &&
            e.target === "app/views/organizations/edit.html.erb" &&
            e.relation === "references",
        ),
      );
    },
  );
});

test("rails views: an ivar contract does not cross into another controller's directory", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/controllers/documents_controller.rb":
        `class DocumentsController < ApplicationController\n  def index\n    @stats = 1\n  end\nend\n`,
      "app/views/reports/index.html.erb": `<%= @stats %>\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges.filter((e) => e.target === "app/views/reports/index.html.erb" && e.relation === "references"),
        [],
      );
    },
  );
});

// ---------------------------------------------------------------------------
// what the container tier buys on its own
// ---------------------------------------------------------------------------

test("rails views: a constant written in a template resolves like one written in a .rb", async () => {
  // `<%= render UI::CardComponent.new %>` is filewerk's commonest render by far —
  // 41 sites — and it needs no view convention at all: it is M1's constant
  // resolution reaching into the template through the container tier.
  await withGraph(
    {
      ...RAILS,
      "app/components/ui/card_component.rb": `module UI\n  class CardComponent\n  end\nend\n`,
      "app/views/documents/index.html.erb": `<%= render UI::CardComponent.new do %>\n  body\n<% end %>\n`,
    },
    (g) => {
      assert.ok(
        g.edges.find(
          (e) =>
            e.source === "app/views/documents/index.html.erb" &&
            e.target === "app/components/ui/card_component.rb#UI.CardComponent" &&
            e.relation === "references",
        ),
      );
    },
  );
});

test("rails views: a receiver typed in a template resolves on that class", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/document_type.rb":
        `class DocumentType < ApplicationRecord\n  def self.ordered\n    all\n  end\nend\n`,
      "app/views/documents/edit.html.erb": `<% DocumentType.ordered.each do |t| %>\n<% end %>\n`,
    },
    (g) => {
      const hit = g.edges.find(
        (e) =>
          e.source === "app/views/documents/edit.html.erb" &&
          e.target === "app/models/document_type.rb#DocumentType.ordered" &&
          e.relation === "calls",
      );
      assert.ok(hit, "M3's receiver typing works inside a template");
      assert.equal(hit.confidence, "type_bound");
    },
  );
});
