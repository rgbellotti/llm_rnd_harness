# Harness scan and improvement plan

Status: scan completed. The Vim textarea work in this pass is implemented.
Project memory stays a separate plan (`docs/design/project_memory.md`).
The local uncommitted `DEFAULT_MODEL` switch in `src/models.rs` was left alone.

## 0. What was examined

Read against the tree, not against a wish list:

- `web/js/vim.js` and `web/js/vim.test.js` (the reported editor lag)
- page structure: `src/page.rs`, `web/index.html`, `web/style.css`, `web/js/tabs.js`
- request boundary: `src/main.rs` routes and body caps, `src/auth.rs`
- tool boundary: `src/tools/run_cmd.rs`, `write_file.rs`, `web.rs`, `src/harden.rs`
- open sudo residuals: `docs/security/run_sudo_cmd_open_findings.md`
- size map: `src/stream.rs` (~5.3k), `src/server.rs`, `src/history.rs`, `web/js/core.js`

This is a single-user localhost harness. "Security" here means the existing
trust boundary (launch token, loopback, approval, secret handling), not a
multi-tenant product review.

## 1. Vim keys — decision and what landed

### Options

1. **Keep the native textarea. Fix measurement. Widen the command set.**
   Chosen. Spellcheck, IME, select-all, copy/cut/paste, and OS integrations
   stay. The browser does not expose a caret rect for a textarea, so a
   mirror is still required for the block cursor and for scroll-into-view
   when lines wrap. That mirror must not be rebuilt on every key.

2. **`contenteditable`.** A DOM Range can report the caret without a mirror.
   Rejected for this harness. Large pasted transcripts, IME, and the
   existing prompt autosave/clip path all assume a textarea `value`. The
   integration bugs are a new project, not a fix.

3. **CodeMirror 6 (or Monaco) with a Vim addon.** The real escape hatch if
   option 1 hits a ceiling. Document model, large-file editing, and a
   maintained Vim map. Cost: a bundler or a vendored build, a second
   editing surface to keep in sync with approval textareas, and giving up
   some OS textarea behavior. Do not start this unless a wrapped prompt of
   a few hundred kilobytes is still sluggish after the mirror change.

4. **A canvas or WASM editor written for this page.** Rejected. It would
   reimplement caret, IME, selection, clipboard, spellcheck, and
   accessibility for one prompt box. CodeMirror already did that work.

### What was slow

`vimMeasureCaret` copied `value.slice(0, caret)` into a DOM node and forced
layout on every motion, and again for the block cursor. `selectionchange`
did the same during a mouse drag in normal mode. A 2–3 session prompt is
hundreds of kilobytes. That is a layout of the whole prefix per key, not a
Vim-command problem.

Insert mode does not draw the block. Ordinary typing was already the
browser's. The `j` chord was the insert-mode exception, because it is
applied with `setRangeText`. That path now uses the newline-count fallback
and does not touch the mirror.

### What changed

- Unwrapped ASCII uses a line-start index and a cached character width.
  No document copy.
- Wrapped or non-ASCII text uses one persistent mirror, updated when the
  text or the width changes, then a `Range` query. The first normal-mode
  motion after an edit pays for one layout. Later motions reuse it.
- Mouse and scroll caret updates coalesce to one frame.
- Undo stores patches, capped at 50 entries and 2 MB. An insert snapshot
  is skipped above 512 KB so focusing a huge prompt does not copy it twice
  for undo.
- Commands added, still on the textarea: counts, `e` `W` `B` `E` `ge`,
  `^`, `f` `t` `F` `T` `;` `,`, `%`, `{` `}`, `/` `?` `n` `N` `*` `#`,
  `d` `c` `y` with motions, `iw`/`aw` and quote/bracket objects, `D` `C`
  `x` `X` `s` `r` `~` `J` `p` `P` `u`, normal-mode `Ctrl-r` redo,
  `Ctrl-d`/`Ctrl-u`, `I` `A` `V`, `>>` `<<`, `.`
- Operator-pending waits until a motion or Esc. The old 200 ms `dd` gap
  made `dw` unreliable. `jj` is still 200 ms.
- Not emulated, on purpose: macros, marks, visual-block, `:` commands,
  named registers, `gj`/`gk`. `g` then `j` still cancels the `g` and moves,
  which is the previous behavior. `Ctrl-c`/`Ctrl-v` stay the browser.
  `p` uses the unnamed register; yank also tries `navigator.clipboard`
  and ignores failure.

## 2. Prioritized backlog

Do these in order. Each item is small enough to review on its own.
Do not start project memory, a bundler, or a custom editor in front of them.

### P1 — Large prompt submit cap

`POST /render` and `POST /approve` allow 32 MB (`RENDER_BODY_LIMIT_BYTES`
in `src/main.rs`). `POST /generate` has no explicit cap, so it keeps
Axum's 2 MB default. A curated 2–3 session prompt can be edited in the
box and then rejected on Generate.

Change: give `/generate` the same 32 MB cap, or a dedicated cap in that
range, and cover it with a handler test. This is local memory, same class
as the render cap that already replaced an unbounded body. Do not remove
the cap.

### P1 — History list default

`HistoryDb::list_runs` uses SQLite `LIMIT -1` when the page omits
`limit`. The README already says the list is unbounded. A long archive
makes the History view the slow page, unrelated to Vim.

Change: the page should request a bounded page (the round window is
already capped at 16). Keep an explicit "load all" for export. Do not
cap `GET /history/{id}` — continue and export need the full record.

### P2 — `stream.rs` split, only at the next edit

`src/stream.rs` is the tool loop, sudo dialog, approval wait, and
provider send path in one file (~5.3k lines). That is a review hazard,
not a runtime bug. The `RunCtx` extraction already started the split.

Change: the next feature that touches the loop should move one concern
out (sudo dialog, or the provider send body), with the existing tests
moved with it. Do not split the file as a drive-by.

### P2 — Wrapped-prompt measurement, only if still slow

After this pass, a wrapped prompt pays one mirror layout per edit, then
a `Range` query per motion. If a few-hundred-kilobyte wrapped prompt is
still sluggish, measure that query before changing editors. Next step
inside the textarea is a line-box cache filled by that one layout, not
a canvas.

CodeMirror 6 is the alternative if that cache is still not enough. Do
not write a WASM text box.

### P3 — Leave these as they are

- **Sudo residuals** in `docs/security/run_sudo_cmd_open_findings.md`.
  The exec-to-`prctl` window, `/sys`, the elevation scanner as a speed
  bump, and the JavaScript password string are documented. Do not reopen
  them without a new failing test.
- **`run_cmd` has no denylist.** Approval is the boundary. A substring
  filter was already removed because it lied.
- **`write_file` allows absolute paths and `../`.** The dialog shows the
  path. That is the single-user contract.
- **Web fetch SSRF checks** (`check_fetch_target`, DNS recheck, numeric
  host rejection) are the mature path. Extend them only when a new
  bypass shows up in `web_tool` tests.
- **Global scripts, no bundler.** `WEB_JS_FILES` is the load order and a
  test pins it. A bundler does not fix caret lag.
- **`innerHTML` for sanitized model HTML** is intentional. New UI text
  stays `textContent`. Do not add a sanitizer bypass to paint faster.
- **Project memory** stays planning-only until P1 is done. The design
  doc is the source. Do not inject memory into the prompt from this scan.

## 3. How to check

```sh
web/js/run_tests.sh
cargo test -- --test-threads=1
```

The Rust suite stays single-threaded. Process-tree tests kill a shared
parallel runner. Frontend tests assert behavior, not the sentences in
the Vim tip.
