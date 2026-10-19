# tools/test-core (vendored)

Vendored from [KakkoiDev/test-core](https://github.com/KakkoiDev/test-core) at commit
`9906fb6b1c5a2bce138d6293b70afb60fe91fb1f` (branch `feat/recipes`), `tools/`; MIT licence (`LICENSE` in this folder).
Copied byte for byte: do not edit here; upgrade by copying the files again from a newer test-core commit and updating
this line.

- `scenarios.py`: every `### Scenario: <title>` (Given/When/Then lines) in a `SCENARIOS.md` has one e2e test named
  exactly after its title, and (with `--junit`) that test ran and passed.
- `e2e_coverage.py`: every control a person can use has an e2e step that uses it; a step that uses a control which no
  longer exists fails.
- `flaky_lint.py`: no fixed waits, no `.only`, no `networkidle`, no real hosts in the test files.

Standard library only (Python 3.10+). CI runs all three (`.github/workflows/test.yml`); locally: `npm run test:protocol`
after `npm run test:e2e`.
