/**
 * Edges that carry dependency meaning for a graph walk/rank: `calls`,
 * `references`, `imports`, `implements`, `extends`, `renders`. `contains` is
 * deliberately excluded — a file "contains" every symbol defined in it, so walking it
 * would make every same-file symbol a neighbour and let a file act as a false
 * hub, flooding a walk that must stay confined to genuine dependency wiring.
 *
 * Shared by `traverse.ts` (callers/callees/impact edge walks), `graphrank.ts`
 * (personalized PageRank), and `search/grep.ts` (in-degree ranking) so every
 * surface agrees on what counts as a dependency edge.
 */
import type { Relation } from "./types.js";

export const WALK_RELATIONS: ReadonlySet<Relation> = new Set<Relation>([
  "calls",
  "references",
  "imports",
  "implements",
  "extends",
  // A controller action reaching its template is a real dependency: renaming the
  // view breaks the action, and "what does this action touch?" must say so.
  "renders",
  "enqueues",
  "dispatches",
]);
