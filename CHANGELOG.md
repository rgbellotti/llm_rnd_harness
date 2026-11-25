# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project's versioning is `MAJOR.MINOR` while pre-1.0.

## [0.1.0] — 2026-11-24

First public release.

### Added

- Chain-able tool-calling sessions with a human gate: every tool call
  opens an approval dialog — Accept, Edit Command, or Alternate Tool
  Call — and captured output passes a second review before the model
  reads it.
- Providers as first-class model sources: local Ollama models, the
  Ollama catalog, xAI (Grok), and Reflection, each with the same
  approval and history path. Grok reasoning effort is per-run
  adjustable, including from an approval dialog.
- Encrypted secrets: an age-encrypted `harness-keys` file behind a
  password typed at each start, with a first-startup wizard
  (`--setup-keys` re-runs it), a `help` menu at the prompt, and
  `set_key` / `set_unreg_keys` / `change_password` maintenance words.
- Permanent session history in a SQLCipher database, with read-only
  recall, exports (text/HTML/JSON), and session-only history for plain
  unencrypted starts.
- Built-in tools: `run_cmd` (bounded capture, process-tree kills,
  provenance notes), `write_file` (atomic writes, red/green diffs),
  `web_search` / `web_fetch` (two-stage review, extracted-text display),
  `read_pdf`, `ask_user`, `view_img` (normalize to PNG, drag-select
  highlight or crop-and-send), and `run_sudo_cmd_relay` for root
  commands the person runs themselves.
- RAG corpus search: any `*.rag.db` in the workspace root registers as
  a search tool; `tools/build_rag.py` is the reference builder for
  building your own corpora.
- Project memory (HOT/WARM/COLD, `project_mem`) — experimental,
  developer-facing; see the README's feature status table.
- The work pane (workspace directory listing with click-to-copy paths),
  the tools pane with manual tool testing inner tab, the decision tab
  (bool/rating/choice queries against a separate decision model), a vim
  keymap for the prompt editor, context compaction (HID / `[ctx
  compacted]`), and per-round context budget pacing.

### Security

- Per-launch bearer token on a loopback-only server; strict CSP with a
  per-launch nonce; the process re-execs to scrub secrets from its
  environment and marks itself non-dumpable; tool children are started
  without API keys and with their environment scrubbed; secrets never
  reach the page, the transcript, or the repository. The threat model
  and its review history are in `docs/security/`.
