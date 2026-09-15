/**
 * ERB in the container tier — the span mapping, and nothing else.
 *
 * `test/container-extract.test.ts` makes the same argument for Vue and it applies
 * here twice over: a template interleaves dozens of small Ruby regions with HTML
 * rather than holding one contiguous block, so a per-region offset is a per-region
 * chance to be off by one, and a `file:line` that is plausible but wrong sends the
 * reader somewhere else with full confidence.
 *
 * The answer M4 takes is to make the offset zero — the regions are re-laid where
 * they already are and everything between them is blanked to spaces — so most of
 * what is asserted below is a property of that one string: **Ruby written on
 * template line N comes back on line N.** Asserting it directly is what makes a
 * broken region locator fail at its cause rather than one layer downstream.
 *
 * Every ERB rule pinned here was checked against a running oracle first: Ruby
 * 3.4.2's stdlib `ERB` 6.0.7 and Erubi 1.13.1, which is the handler ActionView
 * actually uses. Where the two disagree the comment says so.
 *
 * Fixtures are arrays of lines, so an expected line number is the array index + 1
 * and can be read off the source instead of counted by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  warmContainerGrammars,
  extractContainer,
  embeddedSource,
  containerLangOf,
  containerExtensions,
  isContainerWarm,
} from "../src/graph/container.js";
import { supportedExtensions } from "../src/graph/source-files.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

const ERB = containerLangOf("any.html.erb")!;

/** Line N of the fixture is `lines[N - 1]` — that is the whole point. */
function erb(lines: string[]): string {
  return lines.join("\n") + "\n";
}

/** The 1-based lines of the stitched Ruby, for line-by-line assertions. */
function rubyLines(source: string): string[] {
  const out = embeddedSource(source, ERB);
  assert.ok(out !== null, "embeddedSource returned null — is the grammar warm?");
  return out.split("\n");
}

function spanOf(nodes: { name: string; span: string }[], name: string): string {
  const hit = nodes.find((n) => n.name === name);
  assert.ok(hit, `no node named ${name} (got: ${nodes.map((n) => n.name).join(", ")})`);
  return hit.span;
}

test("erb: the registry claims every .erb flavour and reports it as supported", () => {
  assert.equal(containerLangOf("app/views/documents/index.html.erb")?.name, "erb");
  assert.equal(containerLangOf("app/views/documents/index.turbo_stream.erb")?.name, "erb");
  assert.equal(containerLangOf("app/views/layouts/mailer.text.erb")?.name, "erb");
  assert.equal(containerLangOf("app/views/x/INDEX.HTML.ERB")?.name, "erb", "extension match is case-insensitive");
  assert.equal(containerLangOf("app/models/user.rb"), null);
  // A backup a developer left next to a template is not a template. The tier
  // claims a suffix, not a substring, and `app.html.erb-bkp` really does sit in
  // filewerk's layouts directory.
  assert.equal(containerLangOf("app/views/layouts/app.html.erb-bkp"), null);
  assert.ok(containerExtensions().includes(".erb"));
  assert.ok(supportedExtensions().includes(".erb"), ".erb must be in the -e supported set");
});

test("erb: the grammar is present", async () => {
  await warmContainerGrammars(["erb"]);
  assert.ok(isContainerWarm("erb"), "embedded_template grammar must be available in tree-sitter-wasm");
});

test("erb: every region lands on its own template line", async () => {
  await warmContainerGrammars(["erb"]);
  const lines = [
    "<h1>Documents</h1>", //  1
    "<% total = 0 %>", //  2
    "<p>count</p>", //  3
    "<%= total %>", //  4
    "<div>", //  5
    "  <% if total %>", //  6
    "    <%= total.to_s %>", //  7
    "  <% end %>", //  8
    "</div>", //  9
  ];
  const ruby = rubyLines(erb(lines));

  assert.equal(ruby.length, lines.length + 1, "line count is preserved exactly (the trailing newline splits one more)");
  assert.match(ruby[1], /^\s*total = 0\s*$/, "line 2");
  assert.match(ruby[3], /^\s*total\s*$/, "line 4");
  assert.match(ruby[5], /^\s*if total\s*$/, "line 6");
  assert.match(ruby[6], /^\s*total\.to_s\s*$/, "line 7");
  assert.match(ruby[7], /^\s*end\s*$/, "line 8");
  // The HTML is gone, not merely ignored: a `<h1>` left in place would be parsed
  // as Ruby and could bind a name.
  assert.match(ruby[0], /^\s*$/, "line 1 holds no code");
  assert.match(ruby[8], /^\s*$/, "line 9 holds no code");
});

test("erb: a region keeps its column, not just its line", async () => {
  await warmContainerGrammars(["erb"]);
  // Columns matter for the same reason lines do — an `ask --source` slice and any
  // future column-carrying consumer read them — and they are free here only
  // because the blanking is character-for-character.
  const source = erb(['<div class="x"><%= user.name %></div>']);
  const ruby = rubyLines(source);
  assert.equal(ruby[0].indexOf("user.name"), source.indexOf("user.name"));
});

test("erb: one block may open in one region and close in another", async () => {
  await warmContainerGrammars(["erb"]);
  // The reason the regions are stitched rather than extracted one at a time.
  // Alone, `items.each do |i|` is not a parseable Ruby program and `end` is not
  // either, and the block parameter `i` would be invisible to the tag that reads it.
  const lines = [
    "<% items.each do |item| %>", //  1
    "  <li><%= item.title %></li>", //  2
    "<% end %>", //  3
  ];
  const ruby = rubyLines(erb(lines)).join("\n");
  assert.match(ruby, /items\.each do \|item\|/);
  assert.match(ruby, /item\.title/);
  assert.match(ruby, /\bend\b/);
});

test("erb: `%>` inside a string literal ENDS the tag — the oracle's rule, not the tidy one", async () => {
  await warmContainerGrammars(["erb"]);
  // The tempting implementation tracks string literals so `"a %> b"` stays whole.
  // It would be wrong. Both oracles cut at the first `%>` regardless of quoting:
  //
  //   ERB.new('<%= "a %> b" %>').src
  //     => _erbout.<<(( "a ).to_s); _erbout.<< " b\" %>".freeze
  //   Erubi::Engine.new('<%= "a %> b" %>').src
  //     => _buf << ( "a ).to_s; _buf << ' b" %>'.freeze;
  //
  // So the Ruby really is the unterminated `"a `, and ` b" %>` really is text.
  // Rails would raise a syntax error on this template; graft must not invent a
  // reading that Rails does not have.
  const ruby = rubyLines(erb(['<%= "a %> b" %>']));
  assert.match(ruby[0], /"a\s*$/, 'the region ends at the first `%>`');
  assert.doesNotMatch(ruby[0], /b/, "the tail is template text, not code");
});

test("erb: `<%%` is an escape for a literal `<%`, and carries no code", async () => {
  await warmContainerGrammars(["erb"]);
  // Verified: ERB and Erubi both render `x <%% y %> z` as the TEXT `x <% y %> z`.
  // Reading `y` as Ruby would invent a call out of a documentation example — which
  // is exactly what `<%%` is usually there to write.
  const ruby = rubyLines(erb(["x <%% y %> z"]));
  assert.match(ruby[0], /^\s*$/, "an escaped tag contributes no code");
});

test("erb: a comment tag is not code", async () => {
  await warmContainerGrammars(["erb"]);
  // `<%# … %>` compiles to nothing in both oracles. The mechanism is worth naming:
  // the container keys on the CHILD type (`code`), and the grammar gives a
  // comment_directive a `comment` child instead, so comments are excluded by
  // construction rather than by a second rule that could drift.
  const ruby = rubyLines(erb(["<%# user.destroy! %>", "<%= user.name %>"]));
  assert.match(ruby[0], /^\s*$/, "the comment contributes no code");
  assert.match(ruby[1], /user\.name/, "the tag after it still does");
});

test("erb: trim variants are code, and the trimming does not move a line", async () => {
  await warmContainerGrammars(["erb"]);
  // `<%-` and `-%>` change the OUTPUT's whitespace, never the template's own line
  // numbering — `<%- x = 1 -%>` on line 2 is still line 2. Both oracles agree.
  const lines = [
    "<div>", //  1
    "  <%- rows = 3 -%>", //  2
    "  <%= rows -%>", //  3
    "</div>", //  4
  ];
  const ruby = rubyLines(erb(lines));
  assert.match(ruby[1], /rows = 3/, "line 2");
  assert.match(ruby[2], /^\s*rows\s*$/, "line 3");
});

test("erb: `<%==` (Erubi's raw output) is code", async () => {
  await warmContainerGrammars(["erb"]);
  const ruby = rubyLines(erb(["<%== sanitize(body) %>"]));
  assert.match(ruby[0], /sanitize\(body\)/);
});

test("erb: a multi-line tag keeps every one of its lines", async () => {
  await warmContainerGrammars(["erb"]);
  const lines = [
    "<p>", //  1
    "<%= link_to(", //  2
    '     "Edit",', //  3
    "     edit_path) %>", //  4
    "</p>", //  5
  ];
  const ruby = rubyLines(erb(lines));
  assert.equal(ruby.length, lines.length + 1);
  assert.match(ruby[1], /link_to\($/);
  assert.match(ruby[3], /edit_path\)/);
});

test("erb: CRLF templates keep their line numbering", async () => {
  await warmContainerGrammars(["erb"]);
  // `\r` is preserved along with `\n` rather than blanked, so a CRLF pair stays a
  // single line break. Blanking the `\r` would leave the count right and the
  // bytes wrong; blanking both would shift every line after the first.
  const source = ["<h1>t</h1>", "<% a = 1 %>", "<%= a %>"].join("\r\n") + "\r\n";
  const ruby = rubyLines(source);
  assert.match(ruby[1], /a = 1/, "line 2");
  assert.match(ruby[2], /^\s*a\s*\r?$/, "line 3");
});

test("erb: a multi-byte character before a tag does not shift it", async () => {
  await warmContainerGrammars(["erb"]);
  const lines = [
    "<p>envío — 数</p>", //  1
    "<%= total %>", //  2
  ];
  const ruby = rubyLines(erb(lines));
  assert.match(ruby[1], /^\s*total\s*$/, "line 2");
  assert.match(ruby[0], /^\s*$/, "line 1 holds no code");
});

test("erb: an unterminated tag degrades to fewer edges, never to a thrown build", async () => {
  await warmContainerGrammars(["erb"]);
  // Rails raises a syntax error on this template. A build indexes a whole repo and
  // must not die over one broken file, so the contract here is the tier's usual
  // one: extract what parses, drop the rest, never throw.
  const source = erb(["<h1>x</h1>", "<% a = User.find(1)", "<p>never closed</p>"]);
  assert.doesNotThrow(() => extractContainer("app/views/x/broken.html.erb", source, ERB));
});

test("erb: spans are the template's own, end to end", async () => {
  await warmContainerGrammars(["erb"]);
  // A `def` inside a tag is the only construct that gives a template a node with a
  // span of its own, so it is what the end-to-end assertion has to use. The
  // mechanism it pins is not a curiosity: it is the same offset every call edge
  // out of every template rides on.
  //
  // Ruby spans include the declaration and closing end. The container's offset
  // must stay zero, so each complete definition points at its template lines.
  const lines = [
    "<h1>Report</h1>", //  1
    "<% def headline(row) %>", //  2
    "<%=   row.title %>", //  3
    "<% end %>", //  4
    "<div>", //  5
    "  <% def footer %>", //  6
    "    <%= Time.now %>", //  7
    "  <% end %>", //  8
    "</div>", //  9
  ];
  const { nodes } = extractContainer("app/views/reports/show.html.erb", erb(lines), ERB);
  assert.equal(spanOf(nodes, "headline"), "L2-L4", "the complete def on line 2");
  assert.equal(spanOf(nodes, "footer"), "L6-L8", "the complete def on line 6");
  assert.equal(nodes[0].kind, "file", "the file node stays at index 0");
  assert.equal(nodes[0].span, `L1-L${lines.length + 1}`, "the file node describes the whole template");
});

test("erb: every non-blank position holds the template's own character", async () => {
  await warmContainerGrammars(["erb"]);
  // The invariant the whole milestone rests on, stated directly rather than through
  // a span: the stitched program is the template with the HTML taken out, so at
  // every position that carries code the character is the one the template has at
  // that same line AND column.
  //
  // A per-line substring test is NOT the same assertion and quietly passes less: a
  // line with two tags stitches to "a      b", which is correct and is a contiguous
  // substring of nothing. This is what caught that, and it is also the check that
  // was run over all 124 real templates in the corpus repos — 4,433 lines carrying
  // Ruby, 0 wrong. The fixture below collects every shape those templates use.
  const lines = [
    '<div class="wrap">', //  1
    '  <%= user.name %> — <%= user.email %>', //  2  two tags on one line
    "  <%# a comment %>", //  3
    "  <% if admin? %>", //  4
    '    <a href="<%= edit_path(x) %>">edit</a>', //  5  a tag inside an attribute
    "  <% end %>", //  6
    "  literal <%% not_code %> tag", //  7
    "  <%- trimmed = 1 -%>", //  8
    "  <%=", //  9  a tag spanning three lines
    "    long_call(", // 10
    "      arg) %>", // 11
    "  café 数 — multi-byte before <%= total %>", // 12
    "</div>", // 13
  ];
  const source = erb(lines);
  const stitched = embeddedSource(source, ERB)!;
  const a = source.split("\n");
  const b = stitched.split("\n");
  assert.equal(b.length, a.length, "line count preserved");
  let carriedCode = 0;
  for (let i = 0; i < a.length; i++) {
    if (b[i].trim()) carriedCode++;
    for (let c = 0; c < b[i].length; c++) {
      if (b[i][c] === " ") continue;
      assert.equal(b[i][c], a[i][c], `line ${i + 1} column ${c + 1}`);
    }
  }
  assert.ok(carriedCode >= 8, `the fixture must actually carry code (got ${carriedCode} lines)`);
});

test("erb: a template with no Ruby at all still gets exactly its file node", async () => {
  await warmContainerGrammars(["erb"]);
  const { nodes, rawEdges } = extractContainer("app/views/x/static.html.erb", erb(["<h1>hi</h1>", "<p>no ruby</p>"]), ERB);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "file");
  assert.equal(rawEdges.length, 0);
});

test("erb: a built graph indexes templates and keeps every span inside the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-erb-"));
  mkdirSync(join(dir, "app", "views", "documents"), { recursive: true });
  const template = erb([
    "<h1>Documents</h1>", //  1
    "<% def label(doc) %>", //  2
    "<%=   doc.title %>", //  3
    "<% end %>", //  4
  ]);
  writeFileSync(join(dir, "app", "views", "documents", "index.html.erb"), template);
  writeFileSync(join(dir, "doc.rb"), "class Doc\n  def title\n    @t\n  end\nend\n");

  const outDir = join(dir, "graft");
  await buildGraph(dir, outDir, { reuse: false });
  const graph = readGraph(wiringPath(outDir));

  const templateNodes = graph.nodes.filter((n) => n.path === "app/views/documents/index.html.erb");
  assert.ok(templateNodes.length >= 2, "the template contributes its file node and its def");
  for (const n of templateNodes) {
    const m = /^L(\d+)-L(\d+)$/.exec(n.span);
    assert.ok(m, `span is well-formed: ${n.id} ${n.span}`);
    assert.ok(Number(m[1]) <= Number(m[2]), `span is not inverted: ${n.id} ${n.span}`);
    assert.ok(
      Number(m[2]) <= template.split("\n").length,
      `span stays inside the template: ${n.id} ${n.span}`,
    );
  }
});
