---
name: perchance-platform
description: Perch MCP original perchance-platform development reference; expand against current public documentation.
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
