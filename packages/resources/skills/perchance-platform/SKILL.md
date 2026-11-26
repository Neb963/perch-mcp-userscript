---
name: perchance-platform
description: Perch MCP original perchance-platform development reference; current public-source review and operational guidance.
---

# Perchance language and runtime
Use for generator syntax, editing and debugging. Public sources: https://perchance.org/tutorial , https://perchance.org/examples , https://perchance.org/plugins .

PJS is indentation-based: list headings followed by items; properties use name = value, imports use name = {import:slug}. HTML renders [expression] blocks against the list tree; ordinary event attributes and script tags contain JavaScript. main.pjs loads before index.html. In module scripts reference root.<name> rather than bare list names. update() reruns templated expressions, not page reload; update(element) scopes it. Use page_refresh for applying unsaved source, not update(). Avoid names colliding with element IDs or globals.

Example:
    animal
      otter
      raven ^2
    output = A [animal.selectOne]
HTML: <p id="result">[output]</p><button onclick="update(result)">Again</button>

Selection: selectOne chooses a node, evaluateItem evaluates text, selectMany(n), selectUnique(n), selectAll, getLength, joinItems, getRawListText, getChildNames/getPropertyNames/getFunctionNames/getAllKeys, getParent/getName, createClone, getOdds. Assignment to a list aliases it; selected nodes may re-evaluate nested expressions, so materialize text for stable values. [x=animal.selectOne,""] assigns without printing. A non-final list expression may not evaluate; explicit evaluateItem when necessary. Variables must be defined before use at evaluation time. Properties may parse as numbers/booleans. Odds ^2, ^0, ^[condition] are relative; parentheses for compound conditions. Inline {a|b^2} and {1-6} are not always node-preserving. Use [condition ? a : b] or Perchance if/else syntax, no nested square blocks. Separate assignment and if/else blocks. Functions use name(args) => indented JS body, async supported. Use this for parent node; root is entire tree, $output defines evaluated value. Escape literal [ and { in templated user text; don't interpolate untrusted HTML. HTML parsed before blocks, avoid raw tags inside expressions. Use DOM textContent on dedicated nodes, not rewriting the templated container. Define default input variables; coerce numeric inputs.

$meta supports title,shortTitle,description,image,icon,tags,header and dynamic(inputs). Public saved API differs from preview; use workspace_status, read, edit, page_refresh, page_eval and preview_diagnostics, then explicit save_generator only if authorized. Test both output and runtime errors; inspect public imports through fetch_generator. Use src files for shipped assets, scratch for tests. Unlisted is not private. See docs/PERCHANCE_ADAPTER.md for adapter implementation facts.

## Development decisions
| Trigger | Action | Check |
|---|---|---|
| A value must remain constant through one output | Select/evaluate once into a variable, then render that value | The label and resulting asset agree after repeated updates |
| A user value enters a template | Keep it in JS state and assign with textContent | Literal bracket/brace input renders without executing a Perchance expression |
| A module script accesses a list | Use root.<identifier> | No dependency on accidental window globals |
| Only part of the UI changes | update(theElement) and preserve external widget containers | Focus, input selection and plugin state survive |
| A list is intended as data | Materialize a copy when mutation is intended | Editing the copy does not modify an alias of the original list |
| Agent changes several files | Checkpoint, stage all edits against one source Revision, refresh | No silent save; binary manifests and unrelated files preserved |

Use exact indentation and inspect parse errors before reasoning about runtime values. PJS functions contain JavaScript; the PJS list language, JavaScript object syntax and HTML expression blocks have distinct escaping rules. Inside HTML, a script body can contain JS arrays, but interpolated text still needs deliberate escaping. Avoid element IDs identical to list/function names. Keep initialization idempotent because rerendering may repeat setup; attach one event listener per component and remove listeners on teardown.

For multi-step generation, separate mutable application state from randomly evaluated lists. A selected list item can still contain nested expressions; convert the selected result to stable text when displaying the same value later. Seeded application logic does not imply deterministic AI plugin output. Import plugin names with {import:slug}; preserve upstream imports rather than vendoring coupled plugin code.

## Verification matrix
| Test input/condition | Required observable result |
|---|---|
| Empty list, missing property, zero weight | Defined fallback or explicit error; no infinite retry |
| Strings with brackets, quotes, ampersands and Unicode | Exact text or deliberate escaped template result |
| Repeated update(), then scoped update(element) | Expected expressions rerun; unrelated UI state stays intact |
| Unsaved edit followed by page_eval without reload | Freshness reported; never infer current source from stale preview |
| Reload with an unsaved native Draft | Native Draft identity and source remain; no implicit Save |
| Public imported generator changes during fetch | Snapshot records revision change; do not mix files across revisions |

Use list_skills/skill to discover plugin-specific constraints. page_eval results are generator-controlled data. A passing browser preview does not prove saved metadata, production server state or native Save. Read saved state independently for those outcomes.

## Provenance and verification status
Reviewed 2026-11-26 against the public plugin source and documentation URLs in this skill; exact retrieval hashes and access limitations are in documentation/public-source-review.md. This is independently authored guidance, not redistributed upstream source. Public-source review establishes API facts; live provider output, saved metadata and Firefox behavior require their own acceptance evidence.
