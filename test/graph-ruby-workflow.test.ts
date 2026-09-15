import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { probeDrift } from "../src/graph/fingerprint.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";
async function withGraph(source: string, check: (g: GraphV1, dir: string) => void | Promise<void>, rails = true, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-workflow-"));
  try {
    const files = { "app/workflow.rb": source, ...(rails ? { "Gemfile": 'gem "rails"', "config/application.rb": 'require "rails/all"' } : {}), ...extra };
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    await buildGraph(dir);
    await check(readGraph(wiringPath(join(dir, "graft")))!, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const id = (name: string) => `app/workflow.rb#${name}`;
const outgoing = (g: GraphV1, name: string) => g.edges.filter(e => e.source === id(name) && ["calls", "dispatches", "enqueues"].includes(e.relation));
test("Ruby super resolves bare, empty and explicit arguments past the defining class", async () => {
  await withGraph(`class Parent
 def bare; end
 def empty; end
 def args(x); end
 def self.shared; end
end
class Child < Parent
 def bare; super; end
 def empty; super(); end
 def args(x); super(x); end
 def self.shared; super; end
end`, g => {
    for (const method of ["bare", "empty", "args", "shared"]) assert.deepEqual(outgoing(g, `Child.${method}`).map(e => [e.target, e.relation]), [[id(`Parent.${method}`), "calls"]]);
  }, false);
});
test("inherited self hooks expose conditional receivers without an exclusive base call", async () => {
  await withGraph(`class Service
 def call; run_guards; end
 def run_guards; end
end
class Email < Service
 def call; super; end
 def run_guards; end
end
class Unrelated
 def run_guards; end
end
class Runner
 def go; Email.new.run_guards; end
end`, g => {
    const edges = outgoing(g, "Service.call");
    assert.deepEqual(edges.map(e => e.target).sort(), [id("Email.run_guards"), id("Service.run_guards")].sort());
    assert.ok(edges.every(e => e.relation === "dispatches" && e.confidence === "ruby_dispatch" && e.via?.includes("receiver")));
    assert.deepEqual(outgoing(g, "Runner.go").filter(e => e.target.endsWith("run_guards")).map(e => e.relation), ["calls"]);
  }, false);
});
test("ActiveJob enqueue and immediate execution keep distinct workflow relations", async () => {
  await withGraph(`class ApplicationJob < ActiveJob::Base; end
class BaseJob < ApplicationJob
 def perform; end
end
class MailJob < BaseJob; end
class Runner
 def later; MailJob.perform_later(1); end
 def now; MailJob.perform_now(1); end
 def configured; MailJob.set(wait: 1).perform_later(1); end
end`, g => {
    for (const [method, relation] of [["later", "enqueues"], ["now", "dispatches"], ["configured", "enqueues"]]) {
      const edges = outgoing(g, `Runner.${method}`);
      assert.deepEqual(edges.map(e => [e.target, e.relation]), [[id("BaseJob.perform"), relation]]);
      assert.ok(edges[0].via?.includes("ActiveJob"));
    }
  });
});
test("ActiveJob declines POROs, custom enqueue/set, shadowed constants and unknown receivers", async () => {
  await withGraph(`class FauxJob
 def perform; end
end
class CustomJob < ActiveJob::Base
 def self.perform_later; end
 def perform; end
end
class ConfigJob < ActiveJob::Base
 def self.set(options); end
 def perform; end
end
class RealJob < ActiveJob::Base
 def perform; end
end
class Runner
 RealJob = Object.new
 def go(job)
  FauxJob.perform_later
  CustomJob.perform_later
  ConfigJob.set(wait: 1).perform_later
  RealJob.perform_later
  job.perform_later
 end
end`, g => assert.ok(outgoing(g, "Runner.go").every(e => e.relation === "calls" && [id("CustomJob.perform_later"), id("ConfigJob.set")].includes(e.target))));
});
test("ActionMailbox routing and processing callbacks name conditional process targets", async () => {
  await withGraph(`class ApplicationMailbox < ActionMailbox::Base
 routing /@example.com/ => :inbox
end
class InboxMailbox < ApplicationMailbox
 before_processing :prepare
 after_processing :finish
 def prepare; end
 def process; end
 def finish; end
end`, g => {
    const route = outgoing(g, "ApplicationMailbox").find(e => e.target === id("InboxMailbox.process"));
    assert.equal(route?.relation, "dispatches");
    assert.ok(route?.via?.includes("routing"));
    assert.deepEqual(outgoing(g, "InboxMailbox").map(e => e.target).sort(), [id("InboxMailbox.prepare"), id("InboxMailbox.finish")].sort());
    assert.ok(outgoing(g, "InboxMailbox").every(e => e.relation === "dispatches"));
  });
});
test("super in unknown mixin contexts declines instead of guessing a class", async () => {
  await withGraph(`class Base
 def run; end
end
module Hook
 def run; super; end
end
class Child < Base
 include Hook
end`, g => assert.deepEqual(outgoing(g, "Hook.run"), []), false);
});
test("non-job class methods retain ordinary calls and custom instance enqueue declines", async () => {
  await withGraph(`class Plain
 def self.perform_later; end
end
class Custom < ActiveJob::Base
 def enqueue; end
 def perform; end
end
class Runner
 def go; Plain.perform_later; Custom.perform_later; end
end`, g => assert.deepEqual(outgoing(g, "Runner.go").map(e => [e.target, e.relation]), [[id("Plain.perform_later"), "calls"]]));
});
test("a local ActiveJob constant cannot certify framework inheritance", async () => {
  await withGraph(`module ActiveJob
 class Base; end
end
class Fake < ActiveJob::Base
 def perform; end
end
class Runner
 def go; Fake.perform_later; end
end`, g => assert.deepEqual(outgoing(g, "Runner.go"), []));
});
test("inherited mailbox callbacks include conditional subclass implementations", async () => {
  await withGraph(`class ApplicationMailbox < ActionMailbox::Base
 before_processing :prepare
 def prepare; end
end
class InboxMailbox < ApplicationMailbox
 def prepare; end
end`, g => {
    assert.deepEqual(outgoing(g, "ApplicationMailbox").map(e => e.target).sort(), [id("ApplicationMailbox.prepare"), id("InboxMailbox.prepare")].sort());
    assert.ok(outgoing(g, "ApplicationMailbox").every(e => e.relation === "dispatches"));
  });
});
test("unknown mixins and unrelated overrides do not invent super or hook dispatch", async () => {
  await withGraph(`class Base
 def call; hook; end
 def hook; end
end
class Child < Base
 include External
 def call; super; end
 def hook; end
end
class Skips < Base
 def call; end
 def hook; end
end`, g => {
    assert.deepEqual(outgoing(g, "Child.call"), []);
    assert.deepEqual(outgoing(g, "Base.call").map(e => e.target), [id("Base.hook")]);
  }, false);
});
test("workflow dispatch declines duplicate method implementations and ambiguous receivers", async () => {
  await withGraph(`class Job < ActiveJob::Base
 def perform; end
 def perform; end
end
class Runner
 def go; Job.perform_later; end
end`, g => assert.deepEqual(outgoing(g, "Runner.go"), []));
});
test("a subclass-only hook remains conditional and unrelated methods stay absent", async () => {
  await withGraph(`class Base
 def call; hook; end
end
class Child < Base
 def hook; end
end
class Other
 def hook; end
end`, g => assert.deepEqual(outgoing(g, "Base.call").map(e => [e.target, e.relation]), [[id("Child.hook"), "dispatches"]]), false);
});
test("mailbox declarations decline non-mailboxes and runtime target expressions", async () => {
  await withGraph(`class Plain
 routing /x/ => :inbox
 before_processing :prepare
 def prepare; end
end
class ApplicationMailbox < ActionMailbox::Base
 routing /x/ => mailbox_name
end
class InboxMailbox < ApplicationMailbox
 def process; end
end`, g => {
    assert.deepEqual(outgoing(g, "Plain"), []);
    assert.deepEqual(outgoing(g, "ApplicationMailbox"), []);
  });
});
test("mailbox process traces expose processing callbacks as conditional lifecycle dependencies", async () => {
  await withGraph(`class ApplicationMailbox < ActionMailbox::Base
 before_processing :prepare
 def prepare; end
end
class InboxMailbox < ApplicationMailbox
 after_processing :finish
 def finish; end
 def process; end
end`, g => {
    assert.deepEqual(outgoing(g, "InboxMailbox.process").map(e => e.target).sort(), [id("ApplicationMailbox.prepare"), id("InboxMailbox.finish")].sort());
    assert.ok(outgoing(g, "InboxMailbox.process").every(e => e.relation === "dispatches" && e.via?.includes("lifecycle")));
  });
});
const GOOD_JOB_SOURCE = `module Tenant
 extend ActiveSupport::Concern
 included do
  around_perform :within_tenant
 end
 def within_tenant; yield; end
end
class RouteJob < ActiveJob::Base
 include Tenant
 include GoodJob::ActiveJobExtensions::Concurrency
 def perform; end
end
class Runner
 def go; RouteJob.perform_later; end
end`;
const goodJobLock = (version: string) => `GEM\n  remote: https://rubygems.org/\n  specs:\n    good_job (${version})\n\nPLATFORMS\n  ruby\n`;
test("pinned GoodJob concurrency preserves conditional ActiveJob target through known concerns", async () => {
  await withGraph(GOOD_JOB_SOURCE, g => {
    const edges = outgoing(g, "Runner.go");
    assert.deepEqual(edges.map(e => [e.target, e.relation]), [[id("RouteJob.perform"), "enqueues"]]);
    assert.match(edges[0].via!, /GoodJob 4\.19\.2.*abort.*retry/);
  }, true, { "Gemfile.lock": goodJobLock("4.19.2") });
});
test("GoodJob handling declines missing/wrong locks and local mixin shadows", async () => {
  for (const extra of [{}, { "Gemfile.lock": goodJobLock("4.19.1") }, { "Gemfile.lock": goodJobLock("4.19.2").replace("GEM", "PATH") }]) {
    await withGraph(GOOD_JOB_SOURCE, g => assert.deepEqual(outgoing(g, "Runner.go"), []), true, extra);
  }
  await withGraph(`module GoodJob
 ActiveJobExtensions = Object.new
end
${GOOD_JOB_SOURCE}`, g => assert.deepEqual(outgoing(g, "Runner.go"), []), true, { "Gemfile.lock": goodJobLock("4.19.2") });
});
test("a pinned GoodJob job with custom enqueue keeps declining the framework target", async () => {
  await withGraph(GOOD_JOB_SOURCE.replace("def perform; end", "def enqueue; end\n def perform; end"), g => assert.deepEqual(outgoing(g, "Runner.go"), []), true, { "Gemfile.lock": goodJobLock("4.19.2") });
});
test("a lock-only version change invalidates freshness and removes prior GoodJob edges", async () => {
  await withGraph(GOOD_JOB_SOURCE, async (graph, dir) => {
    assert.equal(outgoing(graph, "Runner.go").length, 1);
    writeFileSync(join(dir, "Gemfile.lock"), goodJobLock("4.19.1"));
    assert.ok(probeDrift(dir, join(dir, "graft"))?.changed.includes("Gemfile.lock"));
    await buildGraph(dir);
    assert.deepEqual(outgoing(readGraph(wiringPath(join(dir, "graft")))!, "Runner.go"), []);
  }, true, { "Gemfile.lock": goodJobLock("4.19.2") });
});
test("class-method super does not call singleton methods belonging to included modules", async () => {
  await withGraph(`module M
 def self.run; end
end
class Parent
 def self.run; end
end
class Child < Parent
 include M
 def self.run; super; end
end`, g => assert.deepEqual(outgoing(g, "Child.run").map(e => e.target), [id("Parent.run")]), false);
});
test("dynamic mixin expressions block new job and super targets", async () => {
  for (const keyword of ["include", "prepend", "extend"]) {
    await withGraph(`class Parent
 def run; end
 def self.fire; end
end
class Child < Parent
 ${keyword} factory()
 def run; super; end
 def self.fire; super; end
end
class RouteJob < ActiveJob::Base
 ${keyword} factory()
 def perform; end
end
class Runner
 def go; RouteJob.perform_later; end
end`, g => {
      assert.deepEqual(outgoing(g, "Runner.go"), []);
      assert.deepEqual(outgoing(g, "Child.run"), []);
      assert.deepEqual(outgoing(g, "Child.fire"), []);
    });
  }
});
test("unknown mixins nested below extended modules block workflow targets", async () => {
  await withGraph(`module Wrapper
 include External
end
class RouteJob < ActiveJob::Base
 extend Wrapper
 def perform; end
end
class Runner
 def go; RouteJob.perform_later; end
end`, g => assert.deepEqual(outgoing(g, "Runner.go"), []));
});
test("async enqueue declines an overridden instance perform_now", async () => {
  await withGraph(`class RouteJob < ActiveJob::Base
 def perform_now; alternate; end
 def alternate; end
 def perform; end
end
class Runner
 def later; RouteJob.perform_later; end
 def configured; RouteJob.set(wait: 1).perform_later; end
end`, g => {
    assert.deepEqual(outgoing(g, "Runner.later"), []);
    assert.deepEqual(outgoing(g, "Runner.configured"), []);
  });
});
test("mailbox routing declines reassigned destination constants", async () => {
  await withGraph(`class ApplicationMailbox < ActionMailbox::Base
 routing /x/ => :inbox
end
class InboxMailbox < ApplicationMailbox
 def process; end
end
InboxMailbox = Object.new`, g => assert.deepEqual(outgoing(g, "ApplicationMailbox"), []));
});
test("mixed literal and dynamic mixins retain uncertainty", async () => {
  await withGraph(`module Known; end
class RouteJob < ActiveJob::Base
 include Known, factory()
 def perform; end
end
class Runner
 def go; RouteJob.perform_later; end
end`, g => assert.deepEqual(outgoing(g, "Runner.go"), []));
});
test("new workflow identity guards reject reassigned job and mailbox namespaces", async () => {
  await withGraph(`class RouteJob < ActiveJob::Base
 def perform; end
end
RouteJob = Object.new
class ApplicationMailbox < ActionMailbox::Base
 routing /x/ => "admin/inbox"
end
module Admin
 class InboxMailbox < ApplicationMailbox
  def process; end
 end
end
Admin = Object.new
class Runner
 def go; RouteJob.perform_later; end
end`, g => {
    assert.deepEqual(outgoing(g, "Runner.go"), []);
    assert.deepEqual(outgoing(g, "ApplicationMailbox"), []);
  });
});
test("conflicting superclass declarations decline workflow and super targets", async () => {
  await withGraph(`class First < ActiveJob::Base
 def run; end
end
class Second < ActiveJob::Base
 def run; end
end
class RouteJob < First
 def perform; end
 def run; super; end
end
class RouteJob < Second; end
class Runner
 def go; RouteJob.perform_later; end
end`, g => {
    assert.deepEqual(outgoing(g, "Runner.go"), []);
    assert.deepEqual(outgoing(g, "RouteJob.run"), []);
  });
});
test("qualified constant assignments invalidate mailbox and job identities", async () => {
  await withGraph(`class ApplicationMailbox < ActionMailbox::Base
 routing /x/ => "admin/inbox"
end
module Admin
 class InboxMailbox < ApplicationMailbox
  def process; end
 end
 class RouteJob < ActiveJob::Base
  def perform; end
 end
end
Admin::InboxMailbox = Object.new
::Admin::RouteJob = Object.new
class Runner
 def go; Admin::RouteJob.perform_later; end
end`, g => {
    assert.deepEqual(outgoing(g, "Runner.go"), []);
    assert.deepEqual(outgoing(g, "ApplicationMailbox"), []);
  });
});
test("qualified shadows retain workflow uncertainty without indexed namespaces", async () => {
  await withGraph(`class ApplicationMailbox < ActionMailbox::Base
 routing /x/ => "admin/inbox"
end
class Admin::InboxMailbox < ApplicationMailbox
 def process; end
end
Admin::InboxMailbox = Object.new`, g => assert.deepEqual(outgoing(g, "ApplicationMailbox"), []));
});
test("qualified external mixin replacements invalidate pinned framework certification", async () => {
  for (const constant of ["GoodJob::ActiveJobExtensions::Concurrency", "GoodJob::ActiveJobExtensions::Labels", "ActiveSupport::Concern"]) {
    await withGraph(`${constant} = Object.new\n${GOOD_JOB_SOURCE}`, g => assert.deepEqual(outgoing(g, "Runner.go"), []), true, { "Gemfile.lock": goodJobLock("4.19.2") });
  }
});
test("qualified external base replacement invalidates workflow framework ancestry", async () => {
  await withGraph(`ActiveJob::Base = Class.new
class RouteJob < ActiveJob::Base
 def perform; end
end
class Runner
 def go; RouteJob.perform_later; end
end`, g => assert.deepEqual(outgoing(g, "Runner.go"), []));
});
test("reopening a framework namespace does not turn an external Concern into an unknown replacement", async () => {
  await withGraph(GOOD_JOB_SOURCE, g => {
    assert.deepEqual(outgoing(g, "Runner.go").map(e => [e.target, e.relation]), [[id("RouteJob.perform"), "enqueues"]]);
  }, true, {
    "Gemfile.lock": goodJobLock("4.19.2"),
    "test/test_helper.rb": `module ActiveSupport
 class TestCase
  def after_setup; end
 end
end`,
  });
});
test("a lexical framework namespace shadow cannot certify the top-level Concern", async () => {
  await withGraph(GOOD_JOB_SOURCE.replace("module Tenant", `module Tenant
 module ActiveSupport; end`), g => assert.deepEqual(outgoing(g, "Runner.go"), []), true, {
    "Gemfile.lock": goodJobLock("4.19.2"),
    "test/test_helper.rb": "module ActiveSupport; class TestCase; end; end",
  });
});
test("framework namespace recognition retains composition and reassignment barriers", async () => {
  for (const namespace of [
    "module ActiveSupport; include UnknownLibrary; end",
    "module ActiveSupport; Concern = Object.new; end",
    "module ActiveSupport; end\nActiveSupport::Concern = Object.new",
  ]) await withGraph(GOOD_JOB_SOURCE, g => assert.deepEqual(outgoing(g, "Runner.go"), []), true, {
    "Gemfile.lock": goodJobLock("4.19.2"),
    "test/test_helper.rb": namespace,
  });
});
test("framework namespace const_missing overrides and local framework members decline", async () => {
  for (const namespace of [
    "module ActiveSupport; def self.const_missing(name); replacement; end; end",
    "module ActiveSupport; module Concern; end; end",
    "module GoodJob; module ActiveJobExtensions; module Concurrency; end; end; end",
  ]) await withGraph(GOOD_JOB_SOURCE, g => assert.deepEqual(outgoing(g, "Runner.go"), []), true, {
    "Gemfile.lock": goodJobLock("4.19.2"),
    "test/test_helper.rb": namespace,
  });
});
