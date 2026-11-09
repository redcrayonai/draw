# Outside-plugin test fixture

`pinboard` is the builder's test plugin. It never builds with draw from here:
`scripts/fixtures/` is outside `plugins/`, and the builder's scratch copy leaves it out.
Tests copy `v1/` into a temporary git repository, apply `versions.mjs` for each later
tag, and fetch the repository by `file://` URL like any plugin outside this repo.

| Tag | Change | Expected |
|---|---|---|
| `v1.0.0` | `v1/` | added |
| `v1.1.0` | private column appended, new table and index | compatible upgrade |
| `v2.0.0` | a column changes type | refused by `lock` |
| `v2.1.0` | the public view's row gains a field | refused by `lock` |

`plugin.json` holds `DRAW_RANGE`; tests replace it with a range that includes the draw
version under test.
