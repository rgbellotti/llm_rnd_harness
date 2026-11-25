# Manual QA sessions (paste-ready, grok-4.7)

Developer-run checks, kept beside the source. These are manual passes, not
`cargo test` cases — the automated suites are `cargo test` and
`web/js/run_tests.sh`. Each file is one fresh tab.

Before Generate on every tab:

- Model selector: `grok-4.7`
- Reasoning effort: `low`
- One chain at a time. Stop a drifted call and paste that file again.

Scratch files belong under `work_directory/prompt_probe/`. That directory is gitignored. The prompts do not delete files, open the history database, or print secret values.

| Order | File | What it exercises |
| --- | --- | --- |
| 1 | [01-run-cmd.md](01-run-cmd.md) | Edit Command diffs, quoted heredoc file diffs, timeout, output review, Alternate Tool Call |
| 2 | [02-run-cmd-edges.md](02-run-cmd-edges.md) | Non-zero exit, a visible 30s limit, condensed output, optional size cap |
| 3 | [03-ask-user.md](03-ask-user.md) | A note, an option, Other, and five questions in one call |
| 4 | [04-web-search.md](04-web-search.md) | Search review: only the submitted text reaches the model |
| 5 | [05-web-fetch.md](05-web-fetch.md) | Fetch review, a refused loopback URL, a command copied from the page |
| 6 | [06-read-pdf.md](06-read-pdf.md) | PDF info, then one reviewed page range. Skip when no PDF is present |
| 7 | [07-rag.md](07-rag.md) | Corpus search and a kind filter. Skip when no corpus tool is registered |
| 8 | [08-printed-json.md](08-printed-json.md) | A printed tool envelope is not executed |
| 9 | [09-grok-effort.md](09-grok-effort.md) | One round raised from `low` to `medium`, then back to `low` |
| 10 | [10-write-file.md](10-write-file.md) | Highlighted new-file content, edit diffs, the non-unique-search refusal |

On a line that changes in place, the words that stayed are a quiet red or green, and the changed word — or, with no whitespace, the changed characters — is the full color. A line that is entirely new or removed stays the full color.

## Operator checks that are not model prompts

These do not need a tool call:

- Vim in the prompt: a click starts insert, Esc or jj leaves it, and h j k l move.
- Theme colors stay in this browser after a reload.
- A long round shows a scroll arrow near an off-screen edge.
- Session options export text, HTML, and JSON. JSON omits tool outputs. HTML includes them and opens offline.
- Below 1920px the page is one column. At 1920px and wider the prompt is the left lane.
