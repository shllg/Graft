/**
 * Rails view conventions — the edges that exist because of where a file is PUT.
 *
 * `DocumentsController#index` renders `app/views/documents/index.html.erb` and
 * neither file mentions the other. Grep cannot find it, no language server crosses
 * it, and it is the most-travelled seam in a server-rendered Rails app. What makes
 * it indexable rather than guessable is that Rails' own view lookup IS a filesystem
 * lookup: the convention names exactly one path, and that path either exists or it
 * does not.
 *
 * **Everything here is a path calculation, and every result is verified against the
 * node set before it becomes an edge.** That is the same discipline `ext/rails-seam`
 * uses, and it buys the same thing and no more: the destination is real. Where this
 * file goes further than the seam scanner is in declining — a convention that cannot
 * name a single target emits nothing rather than picking a candidate, which is the
 * rule the whole Rails effort exists to serve.
 *
 * Every rule below was checked against a running ActionView 8.1.3 before it was
 * written, not read off the guides. Two of those checks changed the design:
 *
 *   1. `controller_path` is derived from the FILE PATH here, not by un-inflecting
 *      the constant. `APIClientsController.controller_path` is `"api_clients"` even
 *      with `inflect.acronym "API"` configured, because Zeitwerk put the file at
 *      `app/controllers/api_clients_controller.rb` and the two must agree. Reading
 *      the path is exact; running the inflector backwards is a guess.
 *
 *   2. A partial spec with no slash resolves against the rendering CONTROLLER's
 *      prefixes — NOT the directory of the template that writes it. Rendering a
 *      template that contains `<%= render "widget" %>` from inside
 *      `app/views/shared/_nav.html.erb`, with the controller's prefix set to
 *      `app/documents`, picks `app/views/app/documents/_widget.html.erb` and never
 *      `app/views/shared/_widget.html.erb` — even though the latter sits right
 *      beside the file that asked for it. The obvious "resolve it next door" rule is
 *      therefore wrong, and wrong in the worst way: it names a file that exists. See
 *      `partialTarget` for what is emitted instead.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { relPosix } from "../util/paths.js";

/**
 * `.html.erb` and nothing else, deliberately.
 *
 * Rails resolves a template by (prefix, name, format, locale, variant, handler) and
 * will happily serve `index.json.jbuilder` or `index.html.haml` for the same action.
 * Modelling one axis of that and calling it the lookup would be a guess wearing a
 * convention's clothes. `.html.erb` is the axis M4 verified end to end; the others
 * each need their own extractor and their own evidence, and until they have it a
 * controller whose only template is `index.json.jbuilder` correctly gets no edge.
 */
const TEMPLATE_SUFFIX = ".html.erb";

/** `<anything>/app/controllers/<prefix>_controller.rb`, capturing both halves. The
 * leading group is `""` in a plain app and `engines/billing/` in an engine, which is
 * what lets the view root be found beside the controller root instead of assumed. */
const CONTROLLER_FILE = /^(.*?)app\/controllers\/(.+)_controller\.rb$/;

/** Where one controller's templates live, in Rails' own vocabulary. */
export interface ControllerViews {
  /** The view root serving this controller — `app/views`, or the engine's own. */
  root: string;
  /** Rails' `controller_path`: `admin/users` for `Admin::UsersController`. */
  prefix: string;
}

/**
 * The view root and `controller_path` for a controller file, or null if the path is
 * not a controller's.
 *
 * The view root is found BESIDE the controller root rather than assumed to be
 * `app/views`, so an engine's controllers resolve against the engine's own templates
 * — and, more importantly, an app whose controllers live somewhere unexpected gets
 * no edges at all rather than edges into another component's views.
 */
export function controllerViews(path: string): ControllerViews | null {
  const m = CONTROLLER_FILE.exec(path);
  if (!m) return null;
  const [, base, prefix] = m;
  // `app/controllers/concerns/authenticatable.rb` is excluded by the suffix, not by
  // a rule: a concern is not a controller and has no `controller_path`.
  return { root: `${base}app/views`, prefix };
}

/**
 * The view root serving a file — `app/views`, or the engine's own.
 *
 * Found beside the `app/` the file itself lives under rather than assumed, so a
 * controller, helper or template inside an engine resolves against that engine's
 * templates. A file under no `app/` at all gets null and declines: `lib/report.rb`
 * calling something named `render` is not rendering a Rails view.
 */
export function viewRootFor(path: string): string | null {
  const m = /^(.*?)app\//.exec(path);
  return m ? `${m[1]}app/views` : null;
}

/** The controller file that owns a view directory — the inverse of
 * {@link controllerViews}, for pairing a template with the actions behind it. */
export function controllerFileFor(root: string, prefix: string): string | null {
  if (!root.endsWith("app/views")) return null;
  return `${root.slice(0, -"views".length)}controllers/${prefix}_controller.rb`;
}

/** Is this path a template the conventions here can name? */
export function isTemplatePath(path: string): boolean {
  return path.toLowerCase().endsWith(TEMPLATE_SUFFIX);
}

/** `app/views` + `documents` + `index` → `app/views/documents/index.html.erb`. */
export function templatePath(root: string, prefix: string, name: string): string {
  return posix.join(root, prefix, `${name}${TEMPLATE_SUFFIX}`);
}

/** The same, for a partial: Rails prefixes the basename with an underscore. */
export function partialPath(root: string, prefix: string, name: string): string {
  return posix.join(root, prefix, `_${name}${TEMPLATE_SUFFIX}`);
}

/** `app/views/documents/index.html.erb` → `documents`, relative to `root`. Null when
 * the template is not under that root at all. */
export function templatePrefix(root: string, path: string): string | null {
  const inside = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  if (inside === null) return null;
  const at = inside.lastIndexOf("/");
  return at < 0 ? "" : inside.slice(0, at);
}

/** A name Rails would accept as a template or partial spec. Anything with
 * interpolation, a variable, or a leading slash is not one — those are the shapes a
 * static pass must decline rather than approximate. */
const SPEC = /^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/i;

/**
 * The file a TEMPLATE spec names. `render "shared/banner"` from a controller and
 * `render template: "shared/banner"` from a view both mean this one.
 *
 * A spec with no slash is resolved against `fallbackPrefix` — for a controller that
 * is its own `controller_path`, which is exactly what `render :edit` means and what
 * ActionController's `_normalize_args(:edit)` produces (`{action: "edit"}`).
 */
export function templateTarget(root: string, spec: string, fallbackPrefix: string | null): string | null {
  if (!SPEC.test(spec)) return null;
  const at = spec.lastIndexOf("/");
  if (at >= 0) return templatePath(root, spec.slice(0, at), spec.slice(at + 1));
  return fallbackPrefix === null ? null : templatePath(root, fallbackPrefix, spec);
}

/**
 * The file a PARTIAL spec names, or null when the convention cannot name exactly one.
 *
 * A spec WITH a slash carries its own prefix and is exact: `render "shared/nav"` is
 * `app/views/shared/_nav.html.erb` wherever it is written.
 *
 * A spec WITHOUT one is the case the oracle settled against the obvious answer. It
 * resolves against the rendering controller's prefix chain, so the file that wins
 * depends on which controller is rendering — and a partial is reachable from many.
 * The one situation where a static pass knows the answer is when the template doing
 * the rendering is itself a conventional view of some controller: the directory it
 * sits in IS that controller's first prefix, so a sibling partial in that same
 * directory is the first candidate Rails tries and wins outright. `ownPrefix` is
 * that directory, and callers pass null for a template whose directory belongs to no
 * controller (`app/views/shared/…`), which declines instead.
 */
export function partialTarget(root: string, spec: string, ownPrefix: string | null): string | null {
  if (!SPEC.test(spec)) return null;
  const at = spec.lastIndexOf("/");
  if (at >= 0) return partialPath(root, spec.slice(0, at), spec.slice(at + 1));
  return ownPrefix === null ? null : partialPath(root, ownPrefix, spec);
}

/** `layout "admin"` → `app/views/layouts/admin.html.erb`. Rails looks layouts up
 * under the `layouts/` prefix like any other template, so a declaration that already
 * carries a slash (`layout "admin/wide"`) names `layouts/admin/wide`. */
export function layoutTarget(root: string, spec: string): string | null {
  if (!SPEC.test(spec)) return null;
  return templatePath(root, "layouts", spec);
}

/** The layout Rails falls back to when no controller in the chain declares one. */
export const DEFAULT_LAYOUT = "application";

/**
 * Methods a view may call on `self` without a receiver, keyed by name.
 *
 * A template's `self` is an `ActionView::Base` — a class this repo does not define —
 * so a bare word in one is NOT the free-function call it is in a `.rb` file, and
 * resolving it by unique name across the repo is the exact pathology M3 removed.
 * filewerk has 45 Ruby top-level `def`s, 44 of them in `spec/`, and among their
 * names are `url_for`, `root_path`, `name` and `metadata`.
 *
 * Two sources make a name legitimately callable, and both are declarations:
 *
 *   - every instance method of a module under an `app/helpers/` directory, because
 *     `include_all_helpers` defaults to true and mixes all of them into every view;
 *   - every name a controller exports with `helper_method :current_user`.
 *
 * A name that more than one of them defines is declined, not chosen.
 */
const HELPERS_DIR = /(?:^|\/)app\/helpers\//;

/** Is this the path of a module whose instance methods every view can call? */
export function isViewHelperPath(path: string): boolean {
  return HELPERS_DIR.test(path) && path.toLowerCase().endsWith(".rb");
}

/**
 * `config.action_controller.include_all_helpers = false` turns the first source off:
 * a controller then sees only its own helper and whatever it declares. Rare, and
 * checked rather than assumed, because assuming it would put an edge into a helper
 * the view provably cannot reach.
 *
 * Read from `config/`, where Rails' own configuration lives, and read shallowly on
 * purpose: a setting computed at runtime is invisible here, and the fallback is
 * Rails' default of `true`. The failure mode of reading it wrong in that direction
 * is edges that should not exist, so anything unreadable keeps the default only
 * because the default is what the overwhelming majority of apps run.
 */
const INCLUDE_ALL_HELPERS_OFF = /include_all_helpers\s*=\s*false/;

/** True unless the app turns `include_all_helpers` off. `repoFiles` is the
 * working-tree listing the build already walked — absolute, as `discoverZeitwerk`
 * takes it — so nothing is enumerated twice. */
export function readIncludeAllHelpers(root: string, repoFiles: readonly string[]): boolean {
  for (const abs of repoFiles) {
    const rel = relPosix(root, abs);
    if (!rel.startsWith("config/") || !rel.endsWith(".rb")) continue;
    try {
      if (INCLUDE_ALL_HELPERS_OFF.test(readFileSync(abs, "utf8"))) return false;
    } catch {
      // Unreadable config is no evidence either way; keep Rails' default.
    }
  }
  return true;
}
