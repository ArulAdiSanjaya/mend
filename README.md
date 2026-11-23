# mend: one patch tool for every AI edit format

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ArulAdiSanjaya/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ArulAdiSanjaya/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
one command-line tool that applies the edits AI models write, in every format
they write them in, to a tree of text files — every change, or none.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The working directory is the root of the tree. `PATCH` is the patch file, or
`-` / absent for standard input. `SPEC.md` is the whole contract.

## Formats

- **Unified diffs** — often with wrong line numbers; hunks are matched at the
  nearest occurrence to the stated line, adjusted for earlier hunks.
- **SEARCH/REPLACE blocks** — a path line, then `<<<<<<< SEARCH`, the old
  lines, `=======`, the new lines, `>>>>>>> REPLACE`.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with Add / Delete /
  Update File sections, `@@` anchors, `*** Move to:` and `*** End of File`.
- **JSON edits** — one JSON array of edit objects, or one edit object per
  line (`create`, `str_replace`, `insert`).

`--format=NAME` reads one format (`unified`, `search-replace`, `v4a`,
`json`); `auto`, the default, detects it.

## Matching

Each edit's old lines are found at the first of three tiers at which they
occur at least once:

- **tier 0** — every line equal;
- **tier 1** — every line equal once trailing spaces and tabs are removed;
- **tier 2** — every line equal once leading and trailing spaces and tabs are
  removed, with added lines re-indented from the patch's indentation to the
  file's own.

`--strict` matches exactly (tier 0 only) — the house strict applier's
behaviour, and the bar this tool has to beat: drifted whitespace and
indentation are found, not failed.

## Behaviour

- `--check` does everything but write: the same output and exit code, no
  file created, changed or deleted.
- Edits apply in the patch's order to the tree as earlier edits left it.
  A failed edit changes nothing and the edits after it still run, so every
  failure is reported; when any edit failed, no file is written at all.
- Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`
  for a move) plus `ok: <n> file(s)`; exit 1 prints one `error: <code> <path>`
  line per failed edit plus `failed: <k> of <n> edits`; exit 2 prints one
  `error: …` line for a usage, missing-patch, format or parse fault.
- Files keep their own line break (LF or CRLF) and their final line break,
  except where SPEC.md section 6 says otherwise for a unified hunk.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as issued: when
  `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.
- `check.ts` — the practice set on this machine:
  `node check.ts <practice.json>` (the kit carries it at
  `program/generator/practice.json`).
- `SPEC.md` — the specification.

## Practice score

100 of 100 practice checks pass (`node check.ts` on the kit's public
practice set), and hand-made drifted-whitespace cases pass with fuzzy
matching where `--strict` fails — the tiers beat the tier-0 baseline.
