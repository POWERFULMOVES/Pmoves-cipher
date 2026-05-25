#!/usr/bin/env python3
"""Generate test/fixtures/migrate/<scenario>/ from the Python oracle.

Each fixture is a directory containing:
  - input.md        — the markdown topic to migrate
  - expected.html   — oracle output of convert_markdown_topic_to_html
  - expected-warnings.json — oracle warnings list (json array)

Tree fixtures (multi-file) live under their own subdirs with:
  - tree/.brv/context-tree/... — source tree
  - expected-report.json — normalized run_migration report

Run from anywhere:
  /Users/PhatNguyen/Desktop/byterover/notes/eng-2834-migration-test/wt-feat/scripts/migrate-context-tree-py/.venv/bin/python \
      test/fixtures/migrate/_regenerate.py

Re-run whenever the oracle's output changes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ORACLE_DIR = Path(
    "/Users/PhatNguyen/Desktop/byterover/notes/eng-2834-migration-test/wt-feat/"
    "scripts/migrate-context-tree-py"
)
sys.path.insert(0, str(ORACLE_DIR))

from migrate_context_tree import convert_markdown_topic_to_html  # type: ignore

FIXTURES_DIR = Path(__file__).resolve().parent
FIXED_MTIME_MS = 1_700_000_000_000  # 2023-11-14T22:13:20.000Z

# ---------------------------------------------------------------------------
# Single-file fixtures: (name, rel_path, input_md)
# Each exercises ONE edge case in isolation so test failures pinpoint exactly
# which case broke.
# ---------------------------------------------------------------------------
SINGLE_FILE_FIXTURES: list[tuple[str, str, str]] = [
    # Case 1 — H1 title fallback when frontmatter has no title.
    (
        "case-01-h1-title-fallback",
        "docs/h1-fallback.md",
        """\
---
tags: [docs]
---

# H1 Body Title

## Reason
Anchor topic.
""",
    ),
    # Case 2 — Orphan `## Overview` section routes to <bv-reason> when
    # the canonical Reason section is empty/missing.
    (
        "case-02-orphan-overview-to-reason",
        "intro/overview.md",
        """\
---
title: Overview demo
---

## Overview
This overview explains the intent of the topic.

## Facts
- system has 3 components
""",
    ),
    # Case 3 — Unknown frontmatter key triggers a dropped-frontmatter-key
    # warning. Runtime-signal keys remain allow-listed and silent.
    (
        "case-03-unknown-frontmatter-key",
        "ops/keys.md",
        """\
---
title: Unknown key
weird_key: some value
importance: 0.5
---

## Reason
Anchor.
""",
    ),
    # Case 4 — Lede paragraph between H1 and first ## is hoisted to
    # <bv-topic summary> when frontmatter summary is empty.
    (
        "case-04-lede-paragraph-hoist",
        "intro/lede.md",
        """\
---
title: Lede demo
---

# Lede Demo

This lede paragraph should land in the summary attribute.

It can have multiple sentences in the first paragraph.

## Reason
Anchor.
""",
    ),
    # Case 5 — "Rule N:" prefix splits a Rules block when no bullets are
    # present and no blank lines separate the rules.
    (
        "case-05-rule-n-prefix-splitter",
        "ops/rule-prefix.md",
        """\
---
title: Rule N splitter
---

## Narrative
### Rules
Rule 1: MUST validate input before persisting.
Rule 2: SHOULD avoid silent failures.
""",
    ),
    # Case 6 — Any fenced code block in body promotes to <bv-diagram>,
    # type='other' for unknown languages; dedup against ### Diagrams.
    (
        "case-06-fenced-blocks-promote-to-diagram",
        "diagrams/all-fences.md",
        """\
---
title: Fence promotion
---

## Reason
Anchor.

**Sample**
```python
print("hi")
```

## Narrative
### Diagrams

**Architecture**
```mermaid
graph LR; A --> B
```
""",
    ),
    # Case 7 — Plural-tolerant Raw Concept labels: **Tasks:**, **Flows:**,
    # **Files:** etc. route to the singular form.
    (
        "case-07-plural-raw-concept-labels",
        "tasks/plurals.md",
        """\
---
title: Plural labels
---

## Raw Concept
**Tasks:**
Implement plural support across the parser.

**Files:**
- src/a.ts
- src/b.ts

**Patterns:**
- `^foo$` (flags: i) - matches foo
""",
    ),
    # Case 8 — Unknown ### subsections under ## Narrative route via
    # NARRATIVE_SUBSECTION_HEURISTIC; unmappable warned + dropped.
    (
        "case-08-narrative-subsection-heuristic",
        "patterns/narrative-extras.md",
        """\
---
title: Narrative extras
---

## Narrative
### Patterns
- one
- two
- three

### Decisions
- chose X over Y because Z

### Mystery
- this subsection has no heuristic mapping
""",
    ),
    # Case 9/10 — Loose bullet styles tolerated in Facts and Raw Concept.
    (
        "case-09-loose-bullets-in-facts",
        "facts/loose-bullets.md",
        """\
---
title: Loose bullets
---

## Facts
- dash fact
* asterisk fact
+ plus fact
1. numbered fact
2. another numbered fact
""",
    ),
    # Case 10b — Rule ID dedup across canonical Narrative > Rules and
    # orphan ## Rules (both produce r-must-validate-input-before-persisting).
    (
        "case-10-rule-id-dedup-across-canonical-orphan",
        "ops/rule-dedup.md",
        """\
---
title: Rule dedup
---

## Narrative
### Rules
- MUST validate input before persisting

## Rules
- MUST validate input before persisting
- SHOULD log every failure
""",
    ),
    # Case 11 — YAML # truncation hazard: unquoted scalar with ' #' inside.
    # PyYAML treats ' #' as inline comment and silently truncates.
    (
        "case-11-yaml-hash-truncation-hazard",
        "frontmatter/hash-hazard.md",
        """\
---
title: hash hazard demo # demo
summary: a value # everything after this is gone
---

## Reason
Anchor.
""",
    ),
    # Case 13 — Type-checked frontmatter readers emit warnings on type
    # mismatch and fall back to next resolution layer.
    (
        "case-13-type-checked-frontmatter",
        "frontmatter/typed.md",
        """\
---
title: 42
summary:
  - this
  - is
  - a list
tags:
  - good
  - 99
  - also good
related: 7
---

# H1 Title For Fallback

## Reason
Anchor.
""",
    ),
    # Synthetic 14 — Empty body.
    (
        "syn-14-frontmatter-only-empty-body",
        "syn/empty.md",
        """\
---
title: Empty body
summary: An entirely-empty body produces a minimal bv-topic.
---
""",
    ),
    # Synthetic 15 — Whitespace-only body (no canonical sections, no
    # orphans, no facts). Tests fallback-only path.
    (
        "syn-15-whitespace-body",
        "syn/whitespace.md",
        """\
---
title: Whitespace only
---




""",
    ),
    # Synthetic 16 — Fenced code inside a Rules block holds a literal
    # `## Section` line. Tests fence-masking in the rules splitter and
    # the section walker — the literal must NOT terminate Rules or split.
    (
        "syn-16-fenced-inside-rules",
        "syn/fenced-rules.md",
        """\
---
title: Fenced inside rules
---

## Narrative
### Rules
Rule 1: MUST do thing one.
```python
## not a section
# also not a rule
Rule 2: also fake
```
Rule 2: MUST do thing two.
""",
    ),
    # Synthetic 17 — Mixed bullets in Raw Concept Changes.
    (
        "syn-17-mixed-bullets-changes",
        "syn/mixed-bullets.md",
        """\
---
title: Mixed bullets
---

## Raw Concept
**Changes:**
- dash change
* asterisk change
+ plus change
1. numbered change
""",
    ),
    # Synthetic 18 — Lowercase canonical heading adjacent to a `---`
    # snippet. Tests the case-sensitivity symmetry fix in the snippet
    # extractor (orphan filter must skip lowercased canonical headings).
    (
        "syn-18-lowercase-canonical-with-snippet",
        "syn/lowercase-canonical.md",
        """\
---
title: Lowercase canonical
---

## reason
foo

---

legacy snippet content that should be dropped with a warning.
""",
    ),
    # Bonus — Unterminated frontmatter delimiter produces a parse_error
    # warning and falls back to no-frontmatter resolution.
    (
        "syn-19-unterminated-frontmatter",
        "syn/unterminated.md",
        """\
---
title: Unterminated
summary: no closing delim follows

## Reason
Anchor.
""",
    ),
    # Bonus — Multi-dot filename (case for _html_sibling_path string
    # concat vs with_suffix). Single-file convert doesn't exercise the
    # sibling path directly, but rel_path_to_topic_path must preserve
    # the inner dot.
    (
        "syn-20-multi-dot-filename",
        "node.js/intro.md",
        """\
---
title: Multi-dot file
---

## Reason
Anchor.
""",
    ),
]


def _write_fixture(name: str, rel_path: str, content: str) -> None:
    fixture_dir = FIXTURES_DIR / name
    fixture_dir.mkdir(parents=True, exist_ok=True)
    (fixture_dir / "input.md").write_text(content, encoding="utf-8", newline="\n")
    (fixture_dir / "rel-path.txt").write_text(rel_path, encoding="utf-8", newline="\n")

    result = convert_markdown_topic_to_html(
        markdown=content, mtime_ms=FIXED_MTIME_MS, rel_path=rel_path
    )
    (fixture_dir / "expected.html").write_text(
        result["html"], encoding="utf-8", newline="\n"
    )
    warnings_path = fixture_dir / "expected-warnings.json"
    warnings_path.write_text(
        json.dumps(result["warnings"], indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> int:
    for name, rel_path, content in SINGLE_FILE_FIXTURES:
        print(f"  fixture: {name}")
        _write_fixture(name, rel_path, content)
    print(f"\n{len(SINGLE_FILE_FIXTURES)} fixture(s) regenerated under {FIXTURES_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
