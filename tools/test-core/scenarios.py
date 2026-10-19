#!/usr/bin/env python3
"""Given/When/Then scenarios in a task file -> one end-to-end test each, named after the scenario's title.

  python3 tools/scenarios.py list TASK.md [--json]
  python3 tools/scenarios.py skeleton TASK.md --lang python|js     # print a test file to fill in
  python3 tools/scenarios.py check TASK.md --tests FILE... [--junit REPORT.xml...]

A scenario in the task file (Markdown list or a ```gherkin block; "And"/"But" continue the step above):

  ### Scenario: Add a task
  - Given I am signed in with an empty list
  - When I add the task "Buy milk"
  - Then I see "Buy milk" in the list

The test for it is named after its title:
  Python      @pytest.mark.scenario("Add a task")  def test_add_a_task(...)   (either one is enough)
  JavaScript  test('Add a task', async ({ page }) => { ... })

`check` exits 1 when a scenario has no test, or (with --junit) when its test did not run and pass. Standard library
only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path

SCENARIO = re.compile(r"^\s*(?:[-*]\s+)?(?:#+\s*)?Scenario(?: Outline)?:\s*(?P<title>.+?)\s*#*\s*$", re.IGNORECASE)
STEP = re.compile(r"^\s*(?:[-*]\s+)?(?P<keyword>Given|When|Then|And|But)\s+(?P<text>.+?)\s*$", re.IGNORECASE)
PY_MARK = re.compile(r"""@pytest\.mark\.scenario\(\s*(?P<q>['"])(?P<title>.+?)(?P=q)\s*\)""")
PY_DEF = re.compile(r"^\s*(?:async\s+)?def\s+(?P<name>test_\w+)\s*\(", re.MULTILINE)
JS_TEST = re.compile(r"""\btest(?:\.(?:only|fixme|fail|slow))?\(\s*(?P<q>['"`])(?P<title>(?:\\.|(?!(?P=q)).)+)(?P=q)""")


@dataclass
class Scenario:
    title: str
    given: list[str] = field(default_factory=list)
    when: list[str] = field(default_factory=list)
    then: list[str] = field(default_factory=list)


def parse(text: str) -> list[Scenario]:
    """Every scenario in a task file, in order."""
    scenarios: list[Scenario] = []
    current_part = None
    for line in text.splitlines():
        if match := SCENARIO.match(line):
            scenarios.append(Scenario(match["title"]))
            current_part = None
        elif scenarios and (match := STEP.match(line)):
            keyword = match["keyword"].lower()
            if keyword in ("and", "but"):
                if current_part is None:
                    continue
            else:
                current_part = keyword
            getattr(scenarios[-1], current_part).append(match["text"])
    return scenarios


def python_name(title: str) -> str:
    """'Add a task' -> 'test_add_a_task'. Japanese stays: 'タスクを追加する' -> 'test_タスクを追加する'."""
    words = re.sub(r"[^\w]+", "_", title.lower(), flags=re.UNICODE).strip("_")
    return f"test_{words}"


def test_titles(path: Path) -> set[str]:
    """Scenario titles a test file implements (marker strings, test function names, JS test titles)."""
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".py":
        return {m["title"] for m in PY_MARK.finditer(text)} | {m["name"] for m in PY_DEF.finditer(text)}
    return {m["title"].replace(f"\\{m['q']}", m["q"]) for m in JS_TEST.finditer(text)}


def implemented(scenario: Scenario, names: set[str]) -> bool:
    return scenario.title in names or python_name(scenario.title) in names


def junit_results(paths: list[Path]) -> dict[str, bool]:
    """Test name -> passed, from JUnit XML reports (pytest --junitxml, Playwright's junit reporter)."""
    results: dict[str, bool] = {}
    for path in paths:
        for case in ET.parse(path).getroot().iter("testcase"):
            name = re.sub(r"\[[^\]]*\]$", "", case.get("name", ""))  # test_x[chromium] -> test_x
            passed = not any(child.tag in ("failure", "error", "skipped") for child in case)
            for key in {name, name.split(" › ")[-1]}:
                results[key] = results.get(key, True) and passed
    return results


def skeleton(scenarios: list[Scenario], lang: str, source: str) -> str:
    if lang == "python":
        out = [f'"""End-to-end tests for {source}: one test per scenario, named after its title."""',
               "import pytest", "from playwright.sync_api import expect", ""]
        for s in scenarios:
            out += ["", f"@pytest.mark.scenario({json.dumps(s.title, ensure_ascii=False)})",
                    f"def {python_name(s.title)}(signed_in_page):"]
            out += [f"    # Given {step}" for step in s.given] or ["    # Given"]
            out += [f"    # When {step}" for step in s.when] or ["    # When"]
            out += [f"    # Then {step}" for step in s.then] or ["    # Then"]
            out += ['    raise NotImplementedError("Arrange (Given), Act (When), Assert (Then) with expect()")', ""]
        return "\n".join(out).rstrip() + "\n"
    out = [f"// End-to-end tests for {source}: one test per scenario, named after its title.",
           "import { test, expect } from './fixtures.js';", ""]
    for s in scenarios:
        out += [f"test({json.dumps(s.title, ensure_ascii=False)}, async ({{ signedInPage: page }}) => {{"]
        out += [f"  // Given {step}" for step in s.given] or ["  // Given"]
        out += [f"  // When {step}" for step in s.when] or ["  // When"]
        out += [f"  // Then {step}" for step in s.then] or ["  // Then"]
        out += ["  throw new Error('Arrange (Given), Act (When), Assert (Then) with expect()');", "});", ""]
    return "\n".join(out).rstrip() + "\n"


def check(task: Path, tests: list[Path], reports: list[Path]) -> tuple[list[dict], bool]:
    scenarios = parse(task.read_text(encoding="utf-8"))
    names: dict[str, list[str]] = {}
    for path in tests:
        for name in test_titles(path):
            names.setdefault(name, []).append(str(path))
    results = junit_results(reports) if reports else None
    rows, ok = [], bool(scenarios)
    for s in scenarios:
        files = names.get(s.title, []) + names.get(python_name(s.title), [])
        row = {"scenario": s.title, "tests": sorted(set(files)), "status": "has a test" if files else "no test"}
        if files and results is not None:
            ran = [results[key] for key in (s.title, python_name(s.title)) if key in results]
            row["status"] = "passed" if ran and all(ran) else ("failed" if ran else "did not run")
        ok = ok and row["status"] in ("has a test", "passed")
        rows.append(row)
    return rows, ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_list = sub.add_parser("list", help="the scenarios in a task file")
    p_list.add_argument("task", type=Path)
    p_list.add_argument("--json", action="store_true")
    p_skel = sub.add_parser("skeleton", help="print a test file with one test per scenario")
    p_skel.add_argument("task", type=Path)
    p_skel.add_argument("--lang", choices=["python", "js"], required=True)
    p_check = sub.add_parser("check", help="every scenario has a test (and, with --junit, it passed)")
    p_check.add_argument("task", type=Path)
    p_check.add_argument("--tests", type=Path, nargs="+", required=True)
    p_check.add_argument("--junit", type=Path, nargs="*", default=[])
    p_check.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    if args.command == "list":
        scenarios = parse(args.task.read_text(encoding="utf-8"))
        if args.json:
            print(json.dumps([asdict(s) for s in scenarios], ensure_ascii=False, indent=2))
        else:
            for s in scenarios:
                print(f"Scenario: {s.title}  ({len(s.given)} given, {len(s.when)} when, {len(s.then)} then)")
        return 0 if scenarios else 1
    if args.command == "skeleton":
        print(skeleton(parse(args.task.read_text(encoding="utf-8")), args.lang, args.task.name), end="")
        return 0
    rows, ok = check(args.task, args.tests, args.junit)
    if args.json:
        print(json.dumps({"ok": ok, "scenarios": rows}, ensure_ascii=False, indent=2))
    else:
        if not rows:
            print(f"{args.task}: no scenarios found (### Scenario: <title>, then Given/When/Then lines)")
        for row in rows:
            where = ", ".join(row["tests"]) or "-"
            print(f"{'ok ' if row['status'] in ('has a test', 'passed') else 'NO '} {row['scenario']}: {row['status']} ({where})")
        print("All scenarios have their test." if ok else "Some scenarios have no passing test.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
