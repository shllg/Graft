/**
 * Container tier — files that are not a language but a wrapper around one.
 *
 * A Vue SFC is the motivating case: `.vue` is HTML-shaped, and everything worth
 * indexing lives inside its `<script>` block. Registering `tree-sitter-vue` as a
 * breadth-tier language (generic.ts) would not help — that grammar parses the
 * shell (`<template>` / `<script>` / `<style>`) and hands back the script body as
 * one opaque `raw_text` node, so the cards would come out empty.
 *
 * So the container grammar is used only to answer "where does the embedded
 * language start and end", and the block itself goes to the DEPTH-tier extractor
 * (extract.ts). A `.vue` file therefore gets the same quality of extraction as a
 * `.ts` file — bindings, imports, resolved calls — not the signature-only output
 * the breadth tier would give.
 *
 * **The span shift is the whole risk here.** `extractFile` numbers its spans from
 * the start of the string it was handed, so every node comes back pointing at a
 * line in the script, not in the `.vue`. A span that is off by even one line is
 * worse than not indexing the file at all: graft's promise is that its
 * `file:line` is exact, and a plausible-but-wrong line silently sends the reader
 * to the wrong place. `test/container-extract.test.ts` pins this against
 * fixtures whose true line numbers are known.
 *
 * ERB (M4) is the second shape, and it is the harder one on exactly that axis: a
 * template interleaves dozens of small Ruby regions with HTML instead of holding
 * one contiguous block, so "add the block's start row" becomes a separate chance
 * to be off by one per tag. It is also the shape a per-region extraction cannot
 * parse at all — `<% items.each do |i| %>` opens a block that a later region
 * closes. Both problems have one answer: put the regions back where they already
 * are and blank everything else to spaces, so there is a single Ruby program and
 * the shift is zero. See `stitchRegions`, and `test/container-erb.test.ts` for
 * the fixtures that pin it.
 */
import { extractFile, mintId, type ExtractOptions, type ExtractResult, type Language, type RawEdge } from "./extract.js";
import { loadWasmLanguage, parseWasm, type TsNode } from "./generic.js";
import { contentHash } from "../util/id.js";
import type { NodeV1 } from "./types.js";

/**
 * How a container's embedded regions relate to each other.
 *
 * `block` — one contiguous region per wrapper node, each a program in its own
 * right. A Vue SFC's `<script>` is this: it parses alone, so it is extracted
 * alone and its spans are shifted back by the block's start row.
 *
 * `interleaved` — many small regions that are ONE program between them.
 * `<% items.each do |i| %>` opens a block that a later `<% end %>` closes, and
 * `<%= i.name %>` in between reads that block's parameter, so extracting region
 * by region would hand the parser fragments that are not valid Ruby and lose
 * every binding that crosses a tag. The regions are stitched back into a single
 * source instead — see `stitchRegions`.
 */
export type ContainerLayout = "block" | "interleaved";

/** A container language: the wrapper grammar, the nodes that hold the embedded
 * source, and which depth-tier extractor to hand that source to. */
export interface ContainerLang {
  name: string;
  exts: string[];
  /** wasm basename in tree-sitter-wasms/out/tree-sitter-<wasm>.wasm */
  wasm: string;
  /** Wrapper nodes that represent one embedded region (e.g. Vue's script_element,
   * ERB's directive/output_directive). More than one because a grammar may spell
   * the same thing several ways — ERB gives `<% %>` and `<%= %>` different types. */
  blocks: readonly string[];
  /** Child of a block holding the raw embedded source (e.g. Vue's raw_text, ERB's
   * `code`). Keying on the child type is also what excludes ERB's
   * `comment_directive`, whose child is `comment`: a `<%# … %>` is not Ruby. */
  body: string;
  /** Depth-tier grammar for the embedded language. TypeScript is a superset of
   * JavaScript, so it parses both `<script>` and `<script lang="ts">`. */
  inner: Language;
  layout: ContainerLayout;
}

/** The container registry. Svelte and Astro are the same shape as Vue and would be
 * a row each, but they are left out until someone has a repo to verify them
 * against — a wrong `body` node type would produce silently misplaced spans.
 *
 * `.erb` claims every flavour (`.html.erb`, `.turbo_stream.erb`, `.text.erb`), and
 * that is right for EXTRACTION: the Ruby in a `.text.erb` is Ruby. Only the view
 * CONVENTIONS (`src/graph/rails-views.ts`) narrow to `.html.erb`, because that is
 * the one whose lookup path M4 verified. `.haml`/`.slim` are not ERB at all — they
 * need their own region locator and their own span test, and are deliberately out. */
export const CONTAINER_LANGS: readonly ContainerLang[] = [
  { name: "vue", exts: [".vue"], wasm: "vue", blocks: ["script_element"], body: "raw_text", inner: "typescript", layout: "block" },
  { name: "erb", exts: [".erb"], wasm: "embedded_template", blocks: ["directive", "output_directive"], body: "code", inner: "ruby", layout: "interleaved" },
];

const byExt = new Map<string, ContainerLang>();
for (const l of CONTAINER_LANGS) for (const e of l.exts) byExt.set(e, l);

/** The container language for a path, or null if none claims it. */
export function containerLangOf(path: string): ContainerLang | null {
  const lower = path.toLowerCase();
  for (const [ext, l] of byExt) if (lower.endsWith(ext)) return l;
  return null;
}

/** Every file extension the container tier claims. */
export function containerExtensions(): string[] {
  return CONTAINER_LANGS.flatMap((l) => l.exts);
}

const loaded = new Map<string, unknown>();

/** Warm the container grammars this repo needs. Same contract as
 * `warmGenericGrammars`: await once before the synchronous parse loop, and an
 * unavailable grammar is skipped rather than fatal (its files then extract to a
 * file node only, exactly as they do today). */
export async function warmContainerGrammars(langNames: Iterable<string>): Promise<void> {
  for (const name of new Set(langNames)) {
    if (loaded.has(name)) continue;
    const row = CONTAINER_LANGS.find((l) => l.name === name);
    if (!row) continue;
    const language = await loadWasmLanguage(row.wasm);
    if (language) loaded.set(name, language);
  }
}

/** True if a container grammar has been warmed (else extraction is file-only). */
export function isContainerWarm(langName: string): boolean {
  return loaded.has(langName);
}

/** `L12-L20` shifted by n lines. The span format is produced in exactly two
 * places (extract.ts and generic.ts) and is always this shape; anything else is
 * returned untouched rather than guessed at. */
function shiftSpan(span: string, lines: number): string {
  const m = /^L(\d+)-L(\d+)$/.exec(span);
  if (!m) return span;
  return `L${Number(m[1]) + lines}-L${Number(m[2]) + lines}`;
}

/** The `.vue` file's own node. Deliberately describes the whole file — line
 * count, hash and size of the SFC, not of the script block — because that is
 * what a reader opening this path will see. */
function containerFileNode(rel: string, source: string, residual: string): NodeV1 {
  return {
    id: rel,
    name: rel.split("/").pop() ?? rel,
    kind: "file",
    path: rel,
    span: `L1-L${Math.max(1, source.split("\n").length)}`,
    signature: null,
    exported: true,
    // "ast", not "generic": the symbols under this file come from the depth-tier
    // extractor with real bindings and specifiers. resolve.ts gates a
    // guess-by-name fallback on `origin === "generic"`, and these nodes must not
    // take it — they carry the information to resolve properly.
    origin: "ast",
    body_hash: contentHash(source),
    chars: source.length,
    body_text: residual,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

/** The body children of one wrapper node, in order. An empty `<script></script>`
 * or `<%%>` has no body child at all and contributes nothing — the file still gets
 * its file node, the same shape as a file whose grammar is missing. */
function bodiesOf(block: TsNode, lang: ContainerLang): TsNode[] {
  const out: TsNode[] = [];
  const kids = block.namedChildCount ?? 0;
  for (let j = 0; j < kids; j++) {
    const body = block.namedChild?.(j);
    if (body && body.type === lang.body) out.push(body);
  }
  return out;
}

/** Every embedded block in document order, as [bodyNode] — an SFC may legally
 * carry two (`<script>` for options/exports plus `<script setup>`), and each
 * needs its own offset. Direct children only: a `block`-layout wrapper puts its
 * blocks at the top level, and descending would let a nested lookalike in. */
function blocks(root: TsNode, lang: ContainerLang): TsNode[] {
  const out: TsNode[] = [];
  const n = root.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const child = root.namedChild?.(i);
    if (!child || !lang.blocks.includes(child.type)) continue;
    out.push(...bodiesOf(child, lang));
  }
  return out;
}

/** Every embedded region of an `interleaved` container, in document order.
 *
 * A full descent, unlike `blocks`: an ERB tag inside an attribute value
 * (`<a href="<%= url %>">`) is a direct child of the template in the grammar as it
 * stands today, but nothing in the container contract promises that, and a region
 * missed here is Ruby silently dropped from the graph rather than a visible error. */
function regions(root: TsNode, lang: ContainerLang): TsNode[] {
  const out: TsNode[] = [];
  const visit = (n: TsNode): void => {
    if (lang.blocks.includes(n.type)) out.push(...bodiesOf(n, lang));
    const kids = n.namedChildCount ?? 0;
    for (let i = 0; i < kids; i++) {
      const child = n.namedChild?.(i);
      if (child) visit(child);
    }
  };
  visit(root);
  out.sort((a, b) => a.startIndex - b.startIndex);
  return out;
}

/** Everything that is not code, with its line structure intact: every character
 * becomes a space except the ones that end a line. Same length, same rows, same
 * columns — and no tokens for the inner grammar to trip over. */
function blankOut(text: string): string {
  return text.replace(/[^\n\r]/g, " ");
}

/**
 * The embedded source of an `interleaved` container, laid out at its ORIGINAL
 * offsets: the regions verbatim, everything between them blanked to spaces.
 *
 * This is the answer to the span shift this file's header warns about, and for a
 * template it is the only safe one. Vue can extract one block and add its start row
 * back afterwards because there is a single offset to add. An ERB template has one
 * per tag — `app/views/app/documents/index.html.erb` has 84 of them — and a
 * per-region shift is a per-region chance to be off by one. Re-laying the regions
 * where they already are makes the shift ZERO, so a span comes back in the
 * template's own coordinates with no arithmetic to get wrong.
 *
 * It is also what Rails does. Erubi (ActionView's ERB handler since 5.1) emits the
 * template's newlines into its compiled Ruby precisely so a backtrace names the
 * template line; `<%= __LINE__ %>` on line 4 of a template really does evaluate to
 * 4 under Erubi. Verified against Erubi 1.13.1, which is also where the stdlib
 * `ERB` differs — it prepends a magic comment and reports 5.
 */
function stitchRegions(source: string, found: readonly TsNode[]): string {
  const out: string[] = [];
  let at = 0;
  for (const r of found) {
    // Regions are sorted and cannot legally overlap; a grammar error that produced
    // an overlap would corrupt every offset after it, so drop rather than splice.
    if (r.startIndex < at) continue;
    out.push(blankOut(source.slice(at, r.startIndex)));
    out.push(source.slice(r.startIndex, r.endIndex));
    at = r.endIndex;
  }
  out.push(blankOut(source.slice(at)));
  return out.join("");
}

/**
 * The embedded source of an `interleaved` container file, laid out at its original
 * offsets — null for any other layout, or when the grammar is not warm.
 *
 * Exported because the span guarantee IS a property of this string: Ruby written on
 * template line N must come back on line N of it. Asserting that directly is what
 * makes a broken region locator fail at its cause instead of one layer downstream,
 * as a span that is quietly off by one.
 */
export function embeddedSource(source: string, lang: ContainerLang): string | null {
  if (lang.layout !== "interleaved") return null;
  const language = loaded.get(lang.name);
  if (!language) return null;
  const root = parseWasm(language, source);
  return root ? stitchRegions(source, regions(root, lang)) : null;
}

/**
 * Extract one container file. Synchronous; needs the grammar pre-warmed.
 *
 * Never throws: a missing grammar, an unparseable SFC or a script block the
 * inner extractor chokes on all degrade to "fewer nodes", because a build must
 * not fail over one component.
 *
 * `opts` is forwarded to the inner depth-tier extractor, so an `.erb` template in a
 * Rails app is parsed with the same Rails vocabulary as a `.rb` file in it.
 */
export function extractContainer(
  rel: string,
  source: string,
  lang: ContainerLang,
  opts: ExtractOptions = {},
): ExtractResult {
  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  const residuals: string[] = [];

  const language = loaded.get(lang.name);
  const root = language ? parseWasm(language, source) : null;

  if (root && lang.layout === "interleaved") {
    const stitched = stitchRegions(source, regions(root, lang));
    let inner: ExtractResult | null = null;
    try {
      inner = extractFile(rel, stitched, lang.inner, opts);
    } catch {
      inner = null; // one bad template, not a bad build
    }
    if (inner) {
      // No shift and no rename pass, both by construction: the regions were
      // re-laid at their own offsets, so the spans are already the template's,
      // and one `extractFile` mints one set of ids for the whole file.
      const [innerFile, ...symbols] = inner.nodes;
      if (innerFile?.body_text) residuals.push(innerFile.body_text);
      nodes.push(...symbols);
      rawEdges.push(...inner.rawEdges);
    }
  } else if (root) {
    // Ids are minted per file by the inner extractor, so two script blocks that
    // both define `setup` would collide. Threading one set across the blocks
    // makes the second one `path#setup~2`, and the rename is applied to that
    // block's edges too so nothing points at an id that no longer exists.
    const minted = new Set<string>([rel]);

    for (const body of blocks(root, lang)) {
      const script = source.slice(body.startIndex, body.endIndex);

      let inner: ExtractResult;
      try {
        inner = extractFile(rel, script, lang.inner);
      } catch {
        continue; // one bad block, not a bad build
      }

      // `raw_text` starts immediately after the `>` of the opening tag, so its
      // row IS the tag's row and the slice begins with that line's newline.
      // Script line 1 is therefore the tail of the tag line, and script line N
      // lands on `.vue` line row + N — which is exactly "add the start row to a
      // 1-based span". Taking the row from the tag node instead would look
      // equivalent and be right only when the tag has no attributes.
      const shift = body.startPosition.row;

      // nodes[0] is the script's own file node: it describes the block, not the
      // file, so it is dropped and its residual folded into the .vue file node.
      const [scriptFile, ...symbols] = inner.nodes;
      if (scriptFile?.body_text) residuals.push(scriptFile.body_text);

      const renamed = new Map<string, string>();
      for (const node of symbols) {
        const id = mintId(node.id, minted);
        if (id !== node.id) renamed.set(node.id, id);
        nodes.push({ ...node, id, span: shiftSpan(node.span, shift) });
      }

      for (const edge of inner.rawEdges) {
        const source_ = renamed.get(edge.source) ?? edge.source;
        const targetId = edge.targetId === undefined ? undefined : (renamed.get(edge.targetId) ?? edge.targetId);
        rawEdges.push({ ...edge, source: source_, ...(targetId === undefined ? {} : { targetId }) });
      }
    }
  }

  // Built last so it can carry the residual, but unshifted first so the file node
  // stays at index 0 like every other tier's output.
  nodes.unshift(containerFileNode(rel, source, residuals.join("\n")));
  return { nodes, rawEdges };
}
