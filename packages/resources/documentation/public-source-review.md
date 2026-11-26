# Public source review — 2026-11-26

Read-only requests retrieved public facts; no provider mutations or inference calls were performed. Raw upstream source remains outside the repository. The skill bodies are original explanations, examples and tests. Redistribution rights for upstream implementation are not assumed.

| Source | Public retrieval | Provider lastEditTime | SHA-256 of returned code field |
|---|---|---|---|
| kv-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=kv-plugin | 1762290231847 | a5edb7f5bf28ab5fb31bd5c4877db0f6c4a7a032e9271690262e10444a8700c1 |
| secret-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=secret-plugin | 1774156774467 | 305699d5df697b00d6b2314fdf0f432f36305266bd5063ad2b03fa7f909e267d |
| super-fetch-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=super-fetch-plugin | 1785571265155 | 3becd031accfdc0de27b6eff56a047f8f11b8cf83edbce36df8b888f78860ebb |
| ai-text-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=ai-text-plugin | 1791720414843 | e5bbf4670554d2750a0b7479ed5552ba508da604461434c3152f0750e6d4e1a0 |
| text-to-image-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=text-to-image-plugin | 1795578229976 | 849bd2a905a801a657553f7fa230619e306d462d2168c8e50228c942d49ce15f |
| upload-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=upload-plugin | 1784672363593 | 422b5b82f4017ce04ff658df754ddb9c4959ed518203d46289f33baf075296ae |
| comments-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=comments-plugin | 1788468501406 | 4b20ff48b15882e15623c1f1048f58179e52c94129a61a12d7d185deccac8619 |
| server-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=server-plugin | 1788541557218 | 303381ddeea0fab4e82c0b17bf305ea63c5cb88046ba829edeaaf411659e5716 |
| doc-server-plugin | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=doc-server-plugin | 1787504301571 | 78c63320b8e54cafbf5c54d32199b8dc2214c09d8788735f404ea8992d046404 |
| tutorial | https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=tutorial | 1764144052259 | 6079f1af60e93206d63a8465f083cd8bc441921e11368891c6b2c7165b520d18 |

Public rendered-document templates were also retrieved through `GET /api/downloadGeneratorOutputTemplate?generatorName=<slug>` for tutorial, ai-text-plugin, text-to-image-plugin, comments-plugin, secret-plugin, kv-plugin, upload-plugin, super-fetch-plugin, doc-server-plugin and ai-character-chat. The server guide template references separate src files; their complete content was not retrieved by that route. POST getGeneratorPageData returned403, so no evidence from that route is claimed.

Confirmed corrections: comments uses one plus followed by comma-separated rules; kv.update must return the whole desired value (the public object decrement shorthand is unsafe as an object update); upload expiration is a minimum retention time; image referenceImage is explicitly ineffective in current public source; server emulator state/files helpers are unsaved-only and do not establish production backup access.

The default skills do not require these URLs to remain available at installation. They are bundled. Runtime plugin imports retain upstream ownership and coupling. Music backend, saved dynamic-metadata field limits, production-state parity and live inference are unresolved external verification gates.
