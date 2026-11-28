# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project's versioning is `MAJOR.MINOR` while pre-1.0.

## [Unreleased]

### Added

- The **history** tab now loads 20 session summaries per page with
  First / Previous / Next / Last controls, a page-range summary, and the
  total recorded count. Returning from an open session keeps the current
  page; deleting the last row on a page moves back to the new final page.
  A **HID** sub-tab recalls a stored event by numeric id, shows its text
  and metadata, and copies the block text without sending it to the model.

- OpenCode Console pay-as-you-go inference is available as the `OPENCODE`
  selector group. Add credits and create an API key in the
  [OpenCode Console](https://opencode.ai/console), store it as
  `OPENCODE_API_KEY`, then choose an `opencode/<model>` entry. The gateway
  uses OpenAI Chat Completions, sends a stable `x-opencode-session` header,
  and reports dollar cost in `usage.cost`. Free-tier chat models are not
  offered because Console rejects them for external harnesses.

### Changed

- The dashboard's **session options** submenu now keeps only its controls;
  provider-key, reasoning-effort, and export explanatory hints were removed.
  The reasoning selector follows the selected provider: enabled and named
  for Grok or Beam, or disabled with a model-default note for Ollama and
  OpenCode. OpenCode also points to its direct reasoning controls.

- History scroll-arrow proximity areas are now full-width click bands.
  The arrow appears anywhere within the top or bottom band, and clicking
  anywhere in the band jumps to that edge of the text.

### Security

- The per-launch user comment marker is now the first 20 hex characters
  of the 256-bit comment key (80 bits, up from 48). The marker tells the
  model which span of a tool result is you speaking; a longer space
  makes it harder to guess for content that wants to forge that voice.
  The page still accepts the older 12-hex marker when replaying runs
  recorded before this change, and the project-memory guard refuses
  both shapes.

### Fixed

- Pressing Shift during Vim Visual mode no longer cancels the selection,
  so shifted `$` and `G` motions extend it to the line or text end.

- Upward Vim Visual selections now keep the active caret on the moving
  cursor, so the textarea keeps scrolling instead of pinning the bottom
  edge of the selection.

- Condensing a long history card from the link at its bottom now brings
  the shortened card back into view when it would otherwise be off-screen.
  The condense link near the card's head keeps the current viewing position.

- History session links open transcripts again in browsers, where the
  tab shell reuses an `HTMLCollection` rather than a test array. The HID
  input starts blank and the history content sits closer to the dashboard.

- Manual `web_fetch` tests in the **tools** tab now show browser stderr and
  non-zero or missing exit status in a separate diagnostics panel below the
  editable result. Quiet runs show no empty panel, and starting another test
  clears stale diagnostics. A missing web-tool entrypoint is caught at startup
  and reports the exact `uv sync` / Playwright setup commands.

- Long command lines in `run_cmd` tool-call cards wrap inside the card
  again. The dual pretty/raw shell view is a pair of `pre` blocks, and
  the browser's own `white-space: pre` for `pre` outranks anything the
  card passes down by inheritance — so a long command ran past the
  card's right edge in live sessions and history replay. The wrap
  contract is now stated on the blocks themselves (`web/style.css`).

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
