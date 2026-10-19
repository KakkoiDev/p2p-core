#!/bin/sh
# The testing protocol (test-core, tools/test-core/): run after `npm run test:e2e` and `npm run test:browser`, which
# write the JUnit reports and the pairing dialog's markup to .test-output/.
#   1. every scenario has an e2e test of the same title, and it ran and passed
#   2. every control has an e2e step; a step that uses a control which no longer exists fails
#   3. no fixed waits, no .only, no networkidle, no real hosts in the test files
set -e
cd "$(dirname "$0")/.."
T=tools/test-core
J=.test-output
echo "== scenarios"
python3 $T/scenarios.py check src/SCENARIOS.md --tests e2e/journeys.test.js --junit $J/junit-journeys.xml
python3 $T/scenarios.py check extras/SCENARIOS.md --tests e2e/journeys.test.js e2e/browser.spec.mjs \
  --junit $J/junit-journeys.xml $J/junit-browser.xml
python3 $T/scenarios.py check examples/SCENARIOS.md --tests e2e/browser.spec.mjs --junit $J/junit-browser.xml
echo "== controls"
python3 $T/e2e_coverage.py --pages examples/index.html examples/match.html "$J/dom/*.html" --tests e2e/browser.spec.mjs
echo "== flaky patterns"
python3 $T/flaky_lint.py e2e
