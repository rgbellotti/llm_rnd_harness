# Contributing

Thank you for looking at the harness. It is a local, single-user LLM
research tool where **every tool call waits for a person's approval** —
that principle is the design center, and changes that weaken it are not
interesting here.

## Build and test

```sh
cargo test                 # Rust suite (process-tree tests need the real kernel)
web/js/run_tests.sh        # frontend suite, plain Node, no bundler
```

CI runs the Rust suite single-threaded (`--test-threads=1`): several
tests kill process groups and re-exec the binary, which does not mix
well with a shared parallel runner. Run it the same way locally if a
process-tree test flakes for you.

The bar for a change is: `cargo check --all-targets` with zero warnings,
both suites green, and tests alongside any behavior change.

## Where things live

- `src/tools/` — one module per tool, plus the registry for JSON custom
  tools. The approval flow lives in `src/stream.rs`.
- `src/model_voice.rs` — every sentence the model reads. Wording changes
  happen there; tests never assert those sentences.
- `src/keys.rs`, `src/harden.rs` — the secrets path and process
  hardening. `docs/security/` records the reasoning; read it before
  touching anything in those files.
- `web/js/` — plain scripts, no bundler, loaded in the order listed in
  `src/page.rs`. `testdom.js` is the shared fake DOM for the Node tests.
- `tools/build_rag.py` — the reference corpus builder; a committed
  fixture under `tools/fixtures/` proves its output validates, so a
  schema change must update both.

## Expectations for a pull request

- New tool calls go through the approval dialog unless there is a
  documented reason otherwise.
- Anything that leaves the machine (a cloud model, a web fetch) says so
  in the UI, and anything secret never reaches the page, the transcript,
  or the repository.
- Update the README when behavior changes; it is the manual.
- Experimental features are labeled as such in the README's feature
  status table — keep that table honest.

The manual QA sessions under `docs/qa/` are paste-ready checks for a
human operator; they complement the automated suites and are worth a
pass before a release.
