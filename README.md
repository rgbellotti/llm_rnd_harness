# llm_rnd_harness v0.1

A local, single-user web harness for LLM research and diagnostics. It drives
a model through chain-able tool-calling sessions. The model can run `bash`
commands (with your approval), its thinking and responses stream live into
the browser, and every prompt/response chain is kept in tabbed sessions you
can copy or export. Providers are first-class: the model selector is the
provider list for a run — a local model through the local Ollama daemon
(`ollama-rs`), a cloud model through the Ollama catalog, xAI, or Reflection —
with the same approval and history path for each. Future compatible providers 
will be added in later versions.

The majority of the README is generated, if anything is unclear contact
me with a subject line involving LLM RND. Not verified for use in production,
this is provided as a usable experimentation/learning tool, or as a template for
your agent to derive from. More inference provider options will be added soon.

## Feature status

| Area | Status |
| --- | --- |
| Tool approvals, `run_cmd`, `write_file`, web search/fetch, `read_pdf`, `view_img`, root-command relay | Stable |
| Encrypted keys + onboarding wizard, session history (SQLCipher), exports, decision tab, work pane, vim prompt editor | Stable |
| Context compaction (HID / `[ctx compacted]`), continue / compact-continue | Beta |
| RAG corpus search (`*.rag.db`) | Beta — no corpus ships in the repository: bring or build your own (see **RAG corpora and tool selection**) |
| Project memory (HOT/WARM/COLD, `project_mem`) | Experimental — a developer feature. Storage and recall work and are recorded like any tool, but the workflow and docs are aimed at developers experimenting with agent-memory designs. Expect changes. |

## Requirements

- Rust toolchain (`cargo`)
- A Linux desktop. The harness reads `/proc`, uses `/dev/urandom`, and
  types its password prompts on a Unix TTY; other platforms are untested
  and unsupported.
- To run with zero setup and zero API keys: [Ollama](https://ollama.com)
  listening locally (default `http://127.0.0.1:11434`) with one chat model
  pulled (`ollama pull <name>` — any chat model). A refresh lists the
  chat models that installation reports. Embedding models stay out of
  the selector; a corpus still names its own embedding model.
- For a Grok model: `XAI_API_KEY` from [console.x.ai](https://console.x.ai), stored in the encrypted `harness-keys` file. Models reached through Ollama do not use it. The page never sees the key. Prepaid credits are loaded in the xAI console; with the default invoiced-billing limit of $0, a request is rejected when the balance is gone. See **Keys**.
- For a Reflection model: `REFLECTION_API_KEY` from [the Reflection console](https://platform.reflection.ai/), stored in the same encrypted `harness-keys` file. It is optional: without it, Reflection models stay in the model selector and refuse to run. The page never sees the key. See **Keys**.
- Session history is a SQLCipher file at `$XDG_DATA_HOME/harness/harness.db`, or `~/.local/share/harness/harness.db` when `XDG_DATA_HOME` is unset. It is encrypted with `HARNESS_DB_KEY`, also stored in the keys file. Override the path with `HARNESS_DB_PATH` or `--history <path>`. With no passphrase anywhere, the harness still starts and history is session-only (in memory, nothing on disk). See **Keys**.
- poppler-utils (`pdfinfo`/`pdftotext`) for `read_pdf` — optional; the tool
  reports a clear error if they are missing
- An Ollama embedding model matching the corpus meta for `rag_search`
  — optional; without it, the `*_search` corpus tool returns a clear
  error

The default chat model is set by `DEFAULT_MODEL` in `src/models.rs` (switchable at runtime — see below). **Data egress:** the default is a
`:cloud` model, so prompts, model responses, tool outputs, and anything a
tool reads are sent to that provider. The harness prints a startup warning
when the selected model is a cloud model. The config view and a quiet line
on each approval dialog repeat `CLOUD — prompts and tool outputs leave this
machine` while that model stays selected. An output review repeats the line
under the text, above **Approve & submit content**. Choose a `LOCAL` model
in the model selector when that is not intended.

TO GET STARTED with zero API keys:

```sh
ollama pull <chat model>   # any chat model, e.g. a gemma or llama tag
cargo run
```

Pick that model in the page's model menu (LOCAL), type a prompt, and
**Generate**. At startup the harness asks once whether to encrypt your
API keys and transcript history — `n` starts plain (history is
session-only for that launch), `y` creates the encrypted keys file
(see **Keys**). The tokenized URL opens in the default browser and is
printed in the terminal. URL tokens are created per launch, and stale
URL tokens will not send requests to inference APIs. Cloud models
(GROK / REFLECTION / the OLLAMA catalog) need their provider API key
stored in the keys file before they run.

## Run it

```sh
cargo run
```

The model can be switched at runtime from the page: click the model name in
the "Model:" line to open the model selector (OLLAMA / LOCAL / GROK /
REFLECTION). OLLAMA is
the published Ollama cloud catalog; those models run on a Pro plan or a
pre-paid balance. LOCAL is the chat models installed in the local Ollama.
GROK is the xAI list. REFLECTION is the Reflection list. The switch applies to the next run and is refused while a
run is in flight; it resets to `DEFAULT_MODEL` (in `src/models.rs`) when the
harness restarts.

The lists are live where a live source exists. At startup the harness
asks your Ollama daemon for its cloud catalog (a signed-in daemon
answers; no key leaves the machine), and asks xAI and Reflection for
their `/v1/models` lists using the keys already in `harness-keys`. When
a provider's fetch succeeds, the menu shows that provider's current
list — renames included. A provider's built-in list answers whenever
the fetch fails — no key set, timeout, or odd response — so the menu
still offers the models the harness knows in advance. The startup
banner says which happened for each provider, so a missing new model is
never a silent gap. LOCAL
reads `/api/tags` each time the page is served: entries served from a
remote host (cloud mirrors) are excluded from the LOCAL group, the same
rule the official Ollama app applies, and embedding-only models stay
out of every group.

Grok models (`grok-4.7`, `grok-4.6`, `grok-4.5`) use the xAI Chat Completions
API at `https://api.x.ai/v1/chat/completions`. They are cloud models: the
approval dialog keeps the cloud warning, and prompts plus tool outputs leave
the machine. The request leaves out xAI's live-search field. Sending
`search_parameters`, even with search turned off, is rejected with HTTP 410.
Retrieval still goes through the harness tools and the approval dialog.
RAG embeddings stay on a local Ollama embedding model.

Grok reasoning effort (⋯ session options) is `low`, `medium`, `high`, or
`xhigh`. It is the level the next Grok run starts with. A model reached
through Ollama does not use that level.
On a Grok run, each approval dialog can set the level for the next round.
That choice stays selected on later calls in the same run. `high` is
the API default and the harness default. Reasoning cannot be turned off.
Every level still streams a visible reasoning trace before the reply or the
tool call. A higher level makes that trace longer, the round slower, and
the reasoning-token bill larger. Those tokens are billed on top of the
visible completion tokens. `grok-4.5` treats `xhigh` as `high`. The per-round
metrics line shows prompt, completion, and reasoning counts, plus the
provider-reported cost when the API sends one.

Reflection models (`Beam-1.0-501B-A23B`) use the Reflection API at
`https://api.reflection.ai/openai/v1/chat/completions`. They are cloud
models: the approval dialog keeps the cloud warning, and prompts plus tool
outputs leave the machine. The request carries no server-side search field;
retrieval goes through the harness tools and the approval dialog. The
reasoning-effort level applies to Reflection runs the same way as Grok: it
is sent as `reasoning_effort` on every request. Reflection requires the
reasoning trace replayed on every earlier assistant message: a multi-round
request without it is rejected with HTTP 400 (`missing_required_parameter`),
so the harness always sends the trace back (`REPLAY_REASONING` in
`src/reflection.rs`). The replay is billed as input tokens.

**Context budget.** When the provider reports a context window, the harness
tells the model the size of the latest prompt at 20%, 40%, 60%, 80%, 90%,
and 96% of that window. One line is kept and rewritten when the next mark
is crossed; the 90% and 96% lines ask the model to wrap up. The count is
the latest request — the reply and tool results just added are not in it
yet. The same sentence, including the percentage, is kept under that round
heading in the transcript and in history. If the provider reports no
window, Generate asks for a token limit before the run starts; the line
then says that number was entered for the run, and it is remembered per
model for the next launch. Leaving it unused sends no budget line. The
Grok models use the published 500,000-token window. An Ollama model uses
`num_ctx` from its model parameters when that value is set.

The server prints the URL to open, token included:

```
LLM server running at http://127.0.0.1:3239/?t=abe0ec75…
```

Open exactly that URL. The harness binds localhost only, and every
request must carry the per-launch token — see **Access control** below.

## Access control

The harness executes shell commands, so its HTTP surface is privileged
even on loopback: loopback is a network boundary, not an identity
check. Three layers keep it to the page it serves:

- **Per-launch token.** A 256-bit random token is generated at startup
  and printed in the URL. Every request must present it — in the
  `X-Harness-Token` header, or as the `t` query parameter for the page
  itself. Another local process or local user can reach the port but
  cannot guess the token, so it cannot start a run, approve a pending
  command, or read the session history.
- **Host allow-list.** The server answers only to `127.0.0.1`,
  `localhost` and `::1` (the listener itself binds IPv4 loopback). A
  DNS-rebinding page resolves to 127.0.0.1 and thereby becomes
  same-origin with the harness; the `Host` header is the one signal the
  server gets, and a rebound request carries the attacker's own host.
- **Same-origin browser requests.** A state-changing request from
  another origin (`Origin`/`Sec-Fetch-Site`) is refused.
- **Small request budget.** State-changing endpoints share a 240-per-minute
  in-process limit, sufficient for normal approval-driven chains but not for
  a local script hammering `/approve` or `/render`. The page uses a nonce-based
  CSP and its authenticated responses are `no-store`/`nosniff`.

Set `HARNESS_ALLOWED_HOSTS` (comma-separated) if the harness is reached
through a tunnel or a reverse proxy under another name — every extra
name is also a name an attacker can put in a `Host` header, so keep it
as small as possible.

The token lives in the URL, so the browser history keeps it. Share the
page with care, and start a new harness for a new session if the URL
has been pasted somewhere. That token is only the page credential. It
is not `XAI_API_KEY` and not `HARNESS_DB_KEY`.

## Keys

`XAI_API_KEY` and `HARNESS_DB_KEY` stay in the harness process. They are
not the per-launch page token (`?t=`), and they are not the comment tag
the page uses to mark a note. The page token is printed so you can open
the page. The other two are not printed, not sent to the page, and not
stored in the database or the repository.

**`XAI_API_KEY`** is the bearer token for `https://api.x.ai/v1`. Grok
models need it. Models reached through Ollama do not. Calls to xAI still
go only to that API and still need prepaid credits in the xAI console.
A missing key leaves Grok in the model selector; the run fails and asks
for the key. The harness does not substitute another provider.

**`REFLECTION_API_KEY`** is the bearer token for the Reflection API. It is
optional: Reflection models need it, and a missing key leaves them in the
model selector refusing to run, the same way Grok behaves without its key.
The harness does not substitute another provider.

**`HARNESS_DB_KEY`** is the passphrase for the history file
(`$XDG_DATA_HOME/harness/harness.db`, or `~/.local/share/harness/harness.db`).
It's a unique passphrase for the session history database. SQLCipher turns it into
the AES-256 key once, when the file is opened, and indexed history reads
use that open connection. Losing the passphrase means the existing
history cannot be opened.

Keep these values in `~/.config/harness-keys` (`$XDG_CONFIG_HOME/harness-keys`
when that variable is set, or the path in `HARNESS_KEYS_FILE`). That file
is not on the workspace volume. The harness encrypts it with a password
you type at each start. The password is not the API key and not the
history passphrase. It is not stored, not printed, and not passed to a
shell command.


On each start the prompt is:

```text
harness-keys password (or 'help' for more options):
```

Type the password to open the file and continue. Type `help` at that
prompt to print the menu of everything it accepts — the two words below.
The menu never spends one of the three login attempts.

Type `change_password`
to set a new one: the current password, then the new password twice,
exactly. The harness then opens as usual. The API key and the history
passphrase inside the file stay as they are. `change_password` is
reserved, so it cannot be the password itself.

Type `set_key` to add, update, or remove one secret: the current
password, then a variable name, then the value (typed hidden). The file
re-encrypts with the same password and the harness continues with the
new value. The variable names are the harness's own secret list —
`XAI_API_KEY`, `REFLECTION_API_KEY`, and `HARNESS_DB_KEY` today — and a
provider registered later joins that list automatically. An empty value
removes a provider key. The history passphrase cannot be removed, only
replaced, and the flow warns that an existing history file will not open
under a replacement passphrase. `set_key` is reserved too. This is the
supported way to put a new provider's key into the file: no script, no
plain-text edit, and the same crash-safe commit the first-launch
encryption uses.

All four prompt words — `change_password`, `set_key`, `set_unreg_keys`,
and `help` — are reserved, so none of them can be chosen as the password
itself.

### First startup

The first start that finds no keys file asks once:

```text
harness-keys: no encrypted keys file was found at ~/.config/harness-keys.
Encrypt your API keys and transcript history now? (y/n):
```

**y** creates the file on the spot. You choose the password (the same
rules as above). The history passphrase is imported from
`HARNESS_DB_KEY` when that variable is set — existing history stays
readable — and generated otherwise: 32 bytes of randomness you never
type or see, protected by the password you just chose. (If a history
database already exists, a generated passphrase starts a fresh record.)
Provider keys found in the environment are imported automatically — the
names are printed, the values never — and every unset key is then offered
once: enter the hidden value, or empty to skip. The file is written
through the same crash-safe commit as everywhere else, and the session
continues with encryption in place.

**n** starts plain to try the harness first. The choice is remembered by
a tiny dated marker, `~/.config/harness-keys.declined` (no secrets in
it), so the question is not repeated. Delete that marker and the next
start asks again; `--setup-keys` runs the same wizard at any time. A
plain start is fully usable: provider keys come from the environment,
and history is session-only — it records to memory all session, never
touches `harness.db` on disk, and does not survive the restart, so a
note each launch says exactly that and points at setting up encryption
(or exporting sessions to HTML/JSON/Text to keep them). An explicit
`--history` or `HARNESS_DB_PATH` is still honored under a plain start,
with a caveat that the file is encrypted under that session's random
passphrase and will not reopen later.

`set_unreg_keys` is also a word at the password prompt: it walks only the
variables without a value — one hidden value or one skip each — and
re-encrypts with the same password. After a provider joins the registry,
that is the quickest way to fill the new slot.

A short password such as `temp` is accepted while the harness is still
being tested. Use 12 characters or more when you are done testing. An
empty password is refused.

The first start that finds a plain-text file asks you to choose that
password, encrypts the file, and overwrites the plain text. Do not
source the file. After it is encrypted, sourcing it does not load the
keys. The harness reads the file itself. An approved shell command, a
PDF read, the web tool, and a custom tool are started without
`XAI_API_KEY` and `HARNESS_DB_KEY`.

If the file is absent (a plain start, or no home to put it in), the
harness still accepts the two variables from
the environment of the process that starts it. Removing them from the
process environment is not enough: Linux keeps the starting environment
at `/proc/<pid>/environ`, and a same-user shell command can read that
file, the process memory, and attach with `ptrace`. When either variable
is in that starting environment, the harness prints a line and
re-executes itself once without those variables. The values cross that
restart in a pipe, not on the command line and not in the new
environment block. The process is non-dumpable. A shell command cannot
read `/proc/<pid>/environ` or `/proc/<pid>/mem`, and cannot `ptrace` it.
Root still can. The keys remain in the process memory
because the harness uses them. Tool processes inherit the non-dumpable
flag. `/proc/<pid>/stat` stays readable.

Do not pass either value as a command-line argument (`ps` shows those).
Do not put them in the repository, in the page, in shell history, or in
a file next to the history database. The history file is under your home
directory by default, not in the workspace. A `--history` or
`HARNESS_DB_PATH` value on a removable disk is readable whenever that
disk is plugged in, including on another machine. Keep the keys file on
the system disk, mode `0600`.

The plain-text file you write the first time, before that encryption,
looks like this. These placeholders are not keys:

```sh
install -m 600 /dev/null "$HOME/.config/harness-keys"
```

```sh
XAI_API_KEY='paste-the-key-from-console.x.ai'
REFLECTION_API_KEY='paste-the-key-from-the-reflection-console'   # optional
HARNESS_DB_KEY='a long passphrase that is not the api key'
```

A leading or trailing space is stripped. Spaces inside the database
passphrase are kept. That passphrase must be at least 12 characters and
at most 1024 bytes. An empty value is refused; it is not used as a
passphrase. The file password is a separate secret and, for now, may be
shorter.

The default history file is `$XDG_DATA_HOME/harness/harness.db`, or
`~/.local/share/harness/harness.db` when `XDG_DATA_HOME` is unset. The
harness creates that directory with mode `0700`. `HARNESS_DB_PATH` selects
another file. `--history <path>` selects another file and wins when both
are set. The harness prints the path it is using.

If `./harness.db` is in the workspace and the chosen path does not exist
yet, the harness moves that file and any `-wal`, `-shm`, `.plaintext`, and
`.encrypting` sidecars, then prints each move. A different filesystem is
copied and the workspace file is removed only after the copy matches. An
existing file at the new path is left alone, and so is the workspace
copy; the harness prints that it did not overwrite. A symlink is not
followed and is not moved.

The first start that has `HARNESS_DB_KEY` set copies an existing
plaintext history file into an encrypted file, opens that copy, and only
then overwrites the plaintext file. A later start with a different
passphrase will not open the encrypted file. The page shows a banner and
**Generate** stays refused until the passphrase matches or you allow an
unrecorded run. The message does not include the passphrase.

## Basic use

1. Type a prompt in the box (Ctrl+Enter also sends) and click **Generate**.
2. Watch the rounds stream in: model thinking, model text, tool calls,
   tool results, and per-round token/timing metrics.
3. Answer any **tool approval** pop-ups (nothing runs without your say-so),
   or **Stop** the run — from the dialog or the Stop button on the session tab row.
4. Chains run until the task completes naturally — there is no round cap,
   because every round waits for your approval anyway, so the chain only
   advances while you keep approving it. Once a chain is longer than eight
   rounds, the page keeps that window on screen and loads the rest from
   session history as you scroll. When the chain ends, a summary
   footer shows total tokens and wall time.

One chain runs at a time (single-user lock). A second request while one is
active gets a "busy" message instead of interleaving runs.

## Work directory

The **work** button on the dashboard opens a pane that prints the workspace
directory: the root's own files first (a download dropped into the harness
directory surfaces immediately at the top), then the subdirectories fanned
out beneath — three path levels deep, dot entries and the tail of a very
large tree capped for readability.

The listing is one surface with two affordances:

- **Click** a name to copy that path to the clipboard — the
  workspace-relative form every tool accepts (`run_cmd` runs in the
  workspace, `view_img` and `write_file` resolve relative paths against
  it). A directory copies with its trailing `/`, so a pasted directory is
  ready for a filename to follow it. The root path printed beside the
  heading copies the same way — the absolute directory, slash included.
- **Drag** across the lines and the names select as plain text, so several
  filenames can be pasted straight into the prompt and the model receives
  exact addresses, not guesses.

Two quiet controls shape the display:

- **Right-click a subdirectory** to collapse or expand it — the hover note
  on every directory name names its current state. A folder full of noise
  folds away to one line; left-click still copies, and text selection is
  untouched.
- The **order pill** in the header (`files first` / `dirs first`) flips
  which group leads at every level, remembered per browser. The default
  leads with files, so a project's documents are never buried under its
  folder structure; one click gives the classic tree order back.

Opening the pane re-reads the directory when the listing is stale, and
**refresh** re-reads it immediately — useful after a run has written
files. Starting a run closes the pane back to the session column.

## Tool approvals

The model can call `ask_user` to ask clarifying questions or present a note
with choices during a running task. The same dialog presents up to five
questions, marks recommended choices with **(recommended)**, and always adds
**Other: (provide your own answer)** with a text field. No answer is selected
automatically. Answer every question and click **Send answers** to continue
the same session. Literal Other answers are preserved, and the questions and
responses appear in tool output and permanent history.

For a note, the model can offer choices such as acknowledging a risk and
continuing, or reconsidering the approach. **Stop run** immediately ends the
chain; choosing a response asks the model to continue according to that
response. Answers do not approve subsequent tool calls. Questions stay open
until you answer. **Stop run**, closing the page, or a disconnect ends the
chain, the same way a tool approval does.

Tool execution requires a native tool call. If a response consists
entirely of a recognizable JSON call envelope for a registered tool, the
harness records a notice and requests one corrective generation per session.
It preserves the original response and records the corrective instruction
in history. Printed JSON is never executed directly. If the retry also
prints a call, the session ends with a notice. JSON embedded in explanations,
incomplete JSON, and ordinary answers do not trigger this retry.

When the model wants to run a `run_cmd` shell command, a dialog shows the
exact command and arguments. Each call also carries a `task` phrase: a brief
sentence describing what that command is accomplishing. The phrase is shown
with the command and is not passed to the shell. Execution is paused until you choose:

- **Accept & run** — runs the model's command. The usual limit is none: the command runs until it finishes. A call can still set `timeout` to `30s` or `20m`; the dialog shows that choice above the command. The same dialog lets you set this command to no time limit, 30 seconds, or 20 minutes before Accept, and the command uses that choice. Output is captured up to 4 MB.
- **Edit Command** — edit this shell command and run your version. The button opens the command and an optional note. The note tells the model about the change. It is placed in front of the tool text the model reads, and it is not passed to the shell. Under the box, the page shows a diff of the model's command against the edited one: removed lines, added lines, and the changed words inside a long line. The diff is computed on this machine. It does not run the command. The next model request sees the command that ran. History keeps the model's original call.
- **Alternate Tool Call** — type instructions in the text field (e.g.
  "use `read_file.py 'data.txt'` instead of `cat data.txt`") and the command
  is *not* executed; your text is fed back to the model as the tool result so
  it continues redirected. The same button is on every tool-call dialog.

There is no general deny-list on commands: an earlier substring filter caught
accidents but was trivially bypassed (`rm -fr`, `rm --recursive --force`,
`find … -delete`), so it bought false confidence rather than safety. A
command that invokes `sudo`, `su`, `pkexec`, or `doas` is the exception: it
is blocked, and the dialog says to use `run_sudo_cmd_relay`. That check is a speed
bump, not a guarantee. The control is the approval dialog — every command is
shown to you in full and nothing runs until you accept it. Read the command before accepting
it. Use **Edit Command** when you want a different command to run, and
**Alternate Tool Call** when the command should not run at all. When the whole command is a quoted heredoc written with `cat >`, `cat >>`, or `tee`, the dialog also shows a before-and-after of that file. The file is only read. Nothing is written until you accept. Other shell writes (`sed -i`, pipes, unquoted heredocs, and redirects of command output) are not guessed. A single tool call captures at most
4 MB of output, with an explicit truncation marker when the cap applies.
The model receives that output without an exit-code line. History keeps
the process exit code on the event and shows it when the run is opened.
The tool-result heading already shows how long the command took.

The config view has **Review run_cmd output**. It is on at each launch. Accepting still runs the command;
a second dialog then opens with the captured output. Edit or trim that text,
or leave it unchanged, then choose **Approve & submit content**. Only the
submitted text reaches the model. The raw capture stays recorded. History
shows that text once. An edited call or output is that same single block:
unchanged lines appear once, a removed line is highlighted in red, and the
line that replaces it follows immediately in green. Web fetch, web search,
PDF, and corpus edits are marked on the text you reviewed and the text you
submitted. A `<user_comment>` block is highlighted in that transcript. The choice is fixed when the run starts, and the
control is refused while a run is in flight. Both dialogs stay open until
you decide. **Stop run** or a disconnect ends the chain. Closing the browser tab during a run asks you to confirm. If the tab still closes, the live run ends and the transcript stays in history with the status interrupted. Open that row to read it. A harness that stops while a run is marked running records that run as interrupted the next time it starts.

The config view also has **Vim keys in text areas**. It is on by default and is saved in this browser. A run in flight does not lock it. **Prompt autosave** sits under that switch. It is on by default and saved in this browser. Turning it off stops the timed prompt copy and the copy made when the page closes. Clear and Restore still work. On a wide screen the prompt lane has the same switch. When it is on, clicking the prompt, the curation box, or a question answer starts in insert mode, and the label at that box's corner reads **vim insert**. Esc, or a second j typed immediately after a j, leaves insert. The cursor is a block in normal mode and the usual line in insert. Counts, word motions, find, search, and the d/c/y operators are included. The (?) tip next to the switch and the docs view list the set. A highlighted selection is still the browser selection, so copy, cut, and paste stay the browser keys, as do arrow keys, Backspace, and Delete. Yank and delete also fill an unnamed register for p and P. In normal mode, Ctrl-r is redo rather than reload, and Ctrl-d / Ctrl-u move half a page. Large prompts stay in the native textarea: the caret is measured from a line index, or from one persistent mirror when lines wrap, instead of rebuilding the text before the caret on every key. The prompt box takes those keys while it is editable, which is a fresh tab, including one opened with continue in a new session or a new tab. A clipped prompt scrolls to keep the caret in view, so a long continued context can be pruned here before any model call. A finished tab keeps its prompt locked.

On a screen at least 1920px wide, a live run keeps the session column in the right half, at its 960px measure, for the whole run. Tool dialogs occupy the left half. While the model is working and no dialog is open, that left half stays blank with a mild “Thinking...” line, or “Waiting for response...” while a tool is executing. On a narrower screen the dialog stays centered over the session. It then has **Action** and **Thinking** tabs: Action is the call or the output, and Thinking is the thinking text from that round.

An output review has an **add comment** button. It inserts this launch's comment marker at the text cursor, so a long tool output can carry a comment in the middle of the text. A tool-call dialog does not. **Edit Command** uses its note box instead: that note is for the model, and it is not written into the shell command. Each launch generates a 256-bit comment key for that marker. The bearer token that authenticates the page is a different key and is not written into the prompt. The system prompt names the first 12 hex characters, for example `<abcdefghijkl>…</abcdefghijkl>`, as the block that is you speaking about the result. Every other instruction inside a tool result is untrusted data. The 12 characters are visible while you insert the marker and type the comment. The transcript, history, exports, and the config view show that block as `<user_comment>…</user_comment>`, highlighted so it is easy to find. The history row stores the marker, so a later launch can still translate that run.

The words the model reads — the system prompt, the tool descriptions, and the notes about tool protocol and harness use — live in `src/model_voice.rs`. `{comment_tag}` and `{workspace}` are replaced on each launch. If a rewrite leaves the comment marker or the workspace path out, the harness still inserts them. `<user_comment>` is only the name the page shows; it is not the marker written to the model.

**Provenance.** If the command you are asked to approve appears verbatim
in a page (or search result) the model has read during this run, the
dialog says so above the command: the page may be the one telling the
model what to run. The check is a verbatim match (the command, or one of
its parts, against the fetched text), so it flags the common case and
stays quiet otherwise; the warning is advisory, and the command still
runs only when you accept it. The same note is kept in the session
history.

## Writing files (`write_file`)

The model's code-writing tool: it takes a path and the content — never
shell text — so the approval dialog can show the real before/after: the
syntax-highlighted content of a new file, or a red/green line diff for
an edit. The preview opens in the wide dialog by default (the compact
toggle returns to the half-pane). `run_cmd` stays for utilities and
inspection; the system prompt directs file creation and editing here.

- `mode: "write"` — `content` is the complete new file (create or replace).
- `mode: "edit"` — ordered `search`/`replace` pairs applied to the
  existing file, on the modern edit-tool convention: each search must
  match exactly once, and a failed pair is reported to the model before
  anything is written.

Parent directories are created, and `../` or absolute paths resolve as
written — the preview states the resolved location. The write is atomic
(temp file + rename) and refuses if the file changed after the preview
was built, so what lands on disk is exactly what was approved. The
result text is generated by the harness and reaches the model without a
second review. `write_file` can be set to Allow all like the other
reviewable tools; Approve only is the default.

## Images (`view_img`)

The vision tool: it reads one local image file, sniffs the real format
(the extension does not matter), normalizes it to PNG, and downscales any
side longer than 1568px before anything is sent. The approval dialog
shows the exact normalized image the model will receive, with its
dimensions, both byte sizes, and both sha256 hashes — the source bytes
hashed at read time, and the normalized PNG.

With a region selected, the dialog offers two modes:

- **Highlight** (default) — drag a rectangle on the preview. The region
  travels as normalized coordinates in the tool result ("the person
  highlighted this part"), and the full image is still attached. Use it
  when the selection keeps its meaning from the surroundings: a sign on a
  wall, one face in a group photo.
- **Send only this region** — attach just the selected pixels. The crop
  is cut server-side from the same normalized image that was hashed and
  shown — never a re-read of the file — then re-encoded and hashed on its
  own, and the tool result says it is a crop, with the region
  coordinates and the crop's hash. Use it when one small detail matters
  inside a large image of many objects, so the tokens go to the detail
  instead of the whole frame. A selection thinner than 8px on a side is
  treated as a slip of the mouse and the full image is attached instead.

Every call opens the approval dialog: `view_img` has no Allow-all mode,
because the attachment is exactly the thing leaving this machine. On a
model that accepts text only, the call is refused up front with a note
telling the model to ask you for a description, so the run continues.
Only the metadata text (and any region and crop notes) is recorded in
history; the base64 pixels travel only to the model.

## Root commands

`run_sudo_cmd_relay` lets the model propose one shell command to run as root,
without the harness ever executing it or handling a password. It is on by
default like the other tools, and can be toggled off in the config view.

- The model proposes the command. The approval window shows it in full, with
  a **copy command** button so you can take it to your own terminal.
- The harness does not run the command and never asks for or stores a
  password. You copy the command, run it in your own terminal as admin, then
  paste the terminal output back into the approval window's input box and
  choose **Submit output to model**. Only the text you paste is returned to
  the model.
- There is no raw capture, no timeout, and no password field: the command is
  the model's proposal and the output is whatever you chose to send. A cloud
  model shows the usual CLOUD warning, since the output you paste leaves this
  machine.

The earlier `run_sudo_cmd` tool — which ran root commands through an askpass
password flow — was replaced by the relay and its implementation has since been
removed from the tree: no askpass helper, no pid-namespace supervisor, and no
password slot exists in the harness any more. The name stays reserved so a
custom tool can never claim it. The design and its security review remain as
records in [docs/design/run_sudo_cmd.md](docs/design/run_sudo_cmd.md) and
[docs/security/run_sudo_cmd_open_findings.md](docs/security/run_sudo_cmd_open_findings.md);
the one live piece that shipped with it — the check that flags
`sudo`/`su`/`pkexec`/`doas` inside a proposed `run_cmd` — lives on in
`src/tools/elevation.rs`.

## Decision queries

The **decision** tab runs a discrete decision — **bool**, **rating**, or
**choice** — against an Ollama *decision model*, independently of the
[Generate] run's model. Decision models are a distinct capability (`d3`-family
locally, `clef`/`d1`/`laya` in the cloud catalog): they do not answer
`/api/chat`, only the daemon's `/v1/systemone` endpoint. The tab works while a
run is in flight, including during an approval window.

- The model selector is separate from the header's model toggle. It lists
  installed local decision models (discovered from `/api/tags` via the
  `decision` capability) plus the published cloud decision models
  (`DECISION_MODELS` in `src/providers/ollama.rs`). It starts on a local
  decision model when one is pulled, else the cloud fallback. A cloud model
  shows the usual CLOUD warning.
- Three sub-tabs: **bool** (yes/no), **rating** (an integer scale, default
  1–5), and **choice** (one of the options you type, one per line).
- Enter the context to decide on (the shared `state`), pick a kind, and choose
  **Run decision**. The harness posts one `/v1/systemone` question whose type
  is `noul` (bool), `score` (rating), or `choice`, and shows the parsed
  decision plus the raw answer (confidence and per-option probabilities where
  the model reports them).
- Nothing is recorded: decision queries are transient, like the **test**
  inner tab of the tools pane.

## Web search and reviewed page retrieval

Install the local Python tools once (Python 3.14+, uv, and Playwright Chromium):

```sh
uv sync --project web_tool
uv run --project web_tool playwright install chromium
```

## Web fetch safety

Fetch targets are checked before execution: URLs with embedded
credentials, look-alike hostnames (`localhost`, `.local`, `.internal`),
control characters, IP literals in private/loopback/link-local space, and
public hostnames that *resolve* into private space are all refused. There
is **no private-fetch override**: the harness is not a general-purpose
internal-network browser. URLs whose query string carries secret-looking
parameters (`token=`, `api_key=`, …) still run but display a warning beside
the approval. Nothing fetched reaches the model until you approve the exact
text in the review dialog (fetch executes on approval, then review follows).
The dialog stays open until you submit.

The browser enforces the same policy itself, now at context scope rather
than page scope:

- **Every redirect hop.** The browser follows a `302` on its own, without
  the harness ever seeing the new target — so the web tool follows the
  chain by hand and checks each hop (including the scheme) before the
  request is made. A public page cannot redirect the fetch into private
  space.
- **Every subresource and popup.** Scripts, stylesheets, page-initiated
  requests, and pages opened with `window.open` are checked against the
  same policy. Service/shared/dedicated workers are blocked, WebSocket
  connections are mocked off the network, WebTransport/WebRTC are disabled,
  and Chromium runs with its OS sandbox
  enabled by default. `WEB_TOOL_NO_SANDBOX=1` is an explicit, warned
  opt-out for systems where the sandbox cannot start.

Carrier-grade NAT space (`100.64.0.0/10`, which hosts cloud metadata
endpoints) and the other special-purpose ranges are refused as well,
including IPv4-mapped IPv6 and 6to4/NAT64 addresses that embed a private
IPv4 target. The standalone `web-tool fetch` command applies the same
policy — it is not only the harness that checks.

The check also follows the request to its end: the address the connection
*actually* went to is verified after the fact. A name that resolves
differently for the check and for the request (DNS rebinding) therefore
cannot return a response — the content of a private address is discarded
instead of being shown. If the peer address cannot be read, the response is
discarded rather than trusted. A request that lands in private space is
still possible in that window, but nothing comes back from it.

`web_search` accepts `{"query":"search terms","max_results":5}` (1–20 results).
It shows the standard approval dialog. Accept runs
`uv run --locked --no-sync --project web_tool web-tool search "search terms" 5`,
streams the raw capture as a preview, then opens the review dialog. Edit or
trim the results, or leave them unchanged, then choose **Approve & submit
content**. Only the submitted text reaches the model. The raw capture stays
in the transcript. Alternate instructions skip the search and redirect the
model.

`web_fetch` accepts `{"url":"https://example.com/page"}`. Approval runs
`web-tool fetch <url>`. The browser waits until DOMContentLoaded and extracts
`document.body` after JavaScript has run. That rendered DOM text is what the
review dialog opens on. A navigation that times out once a body exists is
marked partial in that text and still offered for review. Redirects may
upgrade `http` to `https`. A downgrade or any other scheme change is refused.
The document's HTTP body is kept beside the extraction, capped at 256 KiB, in
the FETCH ORIGINAL preview and on the review dialog's Original HTML tab. The
dialog opens on the Extracted text tab, which is the text you edit and submit.
Page-load notes from the browser (refused requests, failed subresources, and
similar stderr) stay off that extracted text. When a fetch recorded any, the
review dialog shows them on a stderr tab next to Action and Thinking. That
tab is diagnostic and is not submitted. The same split is in the finished
session and in history: a web_fetch window opens on the captured page text,
or on the submitted result, and offers a stderr tab when that fetch recorded
any.
Edit or annotate the extracted text, or leave it unchanged, then choose
**Approve & submit content**. Only submitted content reaches the model. The
script annotates an anchor that has visible text as `† example site·( https://example.com/page )`. A space separates the opening dagger from the link text, and the middle dot sits at the end of that text, against the opening parenthesis. A space sits on each side of the resolved URL, and the space plus closing parenthesis ends the link. An anchor with no visible text omits the middle dot: `†( https://example.com/page )`.

`read_pdf` reads local PDF files via poppler (`pdfinfo` + `pdftotext`). It is
registered like the web tools behind the same two-stage gate: accepting runs
the extraction and then opens the review dialog with the extracted text —
edit or trim it, or leave it unchanged, then choose **Approve & submit
content**. Only submitted content reaches the model. `mode: "info"` returns
just the metadata (pages, title, producer, encryption) without opening the
review stage — a cheap planning call on large documents. `pages` selects
which pages to read (`"1-3"`, `"7"`, `"2,5-7"`); `layout` chooses between
logical order (default), content-stream order, or visual columns for tables.
Files whose *content* is PDF are accepted regardless of extension. Extracted
text is capped at 256 KB at a page boundary with an explicit marker naming
the next page to request; the marker lines (`--- page N ---`) make the
document structure visible to the model. Scanned/image-only PDFs return a
clear "no extractable text" error instead of empty content; password-protected
and zero-page files are refused with explicit messages. Both the execute
dialog and the review dialog stay open until you decide. Raw extraction is
archived in transcripts/history like fetch raw.
PDF paths are resolved and magic-checked only after approval (parsing does not
touch the filesystem), files are capped at 100 MB, page ranges at 64, and
poppler runs under `bwrap` with a read-only filesystem and no network when
`bwrap` is installed. Set `PDF_NO_SANDBOX=1` only if user namespaces are
unavailable.

Tool processes capture at most 4 MB per stream; longer output is truncated with
an explicit marker saying so (this bounds `run_cmd`, `web_tool`, and custom
tools). The cap is enforced *while the process runs*: a command that keeps
writing past the cap is stopped there and then, so the capture can never grow
without bound the way a buffered-then-trimmed capture could. Every tool process
runs in its own process group and is killed as a group when it overruns the
output cap or the timeout, so a backgrounded grandchild does not outlive the
call, and no tool inherits the harness' own terminal input. A process that
explicitly calls `setsid()` can leave the group; that is a documented limit of
process-group cleanup. The optional `web_tool` update check is **off by
default** because `uv pip list --python` executes the workspace venv
interpreter. It runs only with `WEB_TOOL_UPDATE_CHECK=1`, is bounded by the
same capture cap/process-group cleanup, and prints a warning when enabled.
Approval dialogs, questions, and content reviews stay open until you decide.
**Stop run** or a disconnect ends the chain, including a command that is
still running. `run_cmd` defaults to no time limit. A call can set `timeout`
to `30s` or `20m` (20 minutes) when a clock is useful; the approval dialog
shows that choice before the command runs. You can change the limit on that
dialog before Accept, and this command uses your choice. None is the usual
selection.
`read_pdf`, `pdfinfo`/`pdftotext`, and custom tools stay at 30 seconds.
The web tool stays at 90 seconds. RAG output is capped at 256 KB and
PDF text at 256 KB. Stop or disconnect cancels the active workflow. A fetch
capture (stdout, stderr, exit status, timing, and the capped HTTP body) is
recorded in the transcript and in history. Continued context for a web_fetch
preview carries the captured page text and leaves stderr and the HTTP body
out. HTML archives keep those diagnostics as labeled sections. Browser storage
and lean JSON exports retain their existing rules. Tool data remains plain
text, even when it contains markup.

The model sees two ordinary web tools. Fetch results contain `url` and
`content`. Search results contain `query`, `max_results`, and `results`.
Fetch stderr stays on the diagnostic tab unless you copy a note into the
submitted text. Use `WEB_TOOL_UV` to select a different uv executable if needed.
The harness snapshots the web-tool source, lock, and entrypoint at startup and
refuses to run if they change mid-session; restart after updating the tool.
The harness launches arguments directly without a shell. Dependencies are
not installed during tool calls; run the setup commands above when updating
`web_tool`. A fetch that returns no page text opens the review box on a short
note that the page text was empty. The stderr tab holds the retrieval error
so you can write a note for the model if you want it to see one. A capture
that already contains page text or search results opens on that text. The
review box does not place a retrieval-failed line above it. A search that
exits with an error includes that error in the search review, after the
results when any were printed.

## Model HTML rendering

The model is told about the `run_cmd` tool and may use HTML for lists and
tables. Since models also emit markdown unconsciously, common markdown in
responses (`**bold**`, `#`/`##` headings, bullet/numbered lists, pipe
tables, inline/fenced code) is converted to the same markup automatically.
LaTeX display math (`\[...\]` or `$$...$$`) and inline math (`\(...\)` or `$...$`)
render through bundled KaTeX as MathML. The Text view keeps the original
delimiters and source exactly as the model wrote them.
Model responses containing an allowlisted subset (`ul`, `ol`, `li`,
`table`, links, basic inline tags) render formatted, with a Text/Rendered
toggle per round. Everything else — thinking blocks and all
tool outputs — always displays as plain text and is never executed as markup.

Mojo code fences (`mojo` or `🔥`) use a local Prism grammar based on Python,
with Mojo keywords, structs, traits, decorators, and function declarations.
The grammar is bundled for offline use.

## Tabs and manual context

Each prompt/response chain lives in its own **tab**; chains are isolated, so
the model never sees other tabs. You assemble context by hand. On a round,
a response, or an archived prompt, **copy** copies the highlighted text and
**curate** appends that text to the prompt with a blank line and no context
label. **copy full** and **curate full** keep the previous whole-block
actions: the full text, and for curate the `====` labels. **New tab** is
absent until the active chain finishes, then it appears. When the run
finishes, the prompt box clears. The submitted prompt stays on that chain
and in history, and only a new tab has an editable box.

Under **⋯ session options**, **Continue in new tab** and **Continue in new
session** assemble the current chain into a ready-to-prune prompt.
**Continue in new tab** layers on top of the workspace — every existing tab
stays, and later runs tally in that tab's sub-tabs. **Continue in new
session** clears the workspace first (confirming when other tabs hold
unexported work) so the follow-up run becomes a clean, standalone
delineation in the history database. The assembled context is the
model-bound lineage only: one current tool call and one final tool result
per step, with thinking, responses, and the context-budget pacing
notifications. Before-review originals and metadata never enter the box.
**Compact continue** does the same with a chosen degree: tool results,
results and calls, or those plus thinking. Compacted bodies are
`[ctx compacted]`. The header keeps `HID: N`, the `events.id` row, so the
drop is recallable in the box. Blocks with no history id are left intact.
History keeps **Continue in new session** and **Compact continue**. In both cases the assembled context ends with a fresh
`==== PROMPT ====` header, so typing the next prompt underneath keeps each
step of the simulated conversation cleanly delineated for the model.

**Curate** next to **Export** appends a whole session. **curate full** on a
round, response, or archived prompt appends that block. Each of those is
labeled (`==== THINKING (round N) ====`, `==== RESPONSE … ====`,
`==== TOOL CALL name (round N) ====`, `==== TOOL RESULT (round N) ====`).
**curate** on those windows appends only the highlighted text, with a blank
line and no label. Text already under a trailing `==== PROMPT ====` stays
there. On a wide screen, curating from history leaves that recorded session
on the right and appends into the prompt on the left.

The live column does not repeat the prompt. While you are editing, the
area under the controls stays blank, and a run prints its rounds there.
The prompt box clears when the run finishes. History still shows an archived
prompt block, with copy, copy full, curate, and curate full. A long one condenses to the first 8
viewable lines (still scrollable); **show full prompt / condense prompt**
in that block's head toggles it. The prompt box does the same while
composing: above 8 lines it clips to 8 scrollable lines with a **show full
prompt / clip prompt (8 lines)** toggle on the strip beneath the box.

Long rounds (> 60 lines, counting wrapped display lines) condense when they
finish, with click-to-expand / click-to-condense. Hovering a condensed
history round uses the pointer. A tool count on that header lists the
phrase that call recorded: `run_cmd` tasks, `web_search` and
`mydocs_search` queries, `web_fetch` URLs, `read_pdf` filenames, and
`ask_user` questions. The edits count on that header is a short diff: how many lines were added and removed, then the first changed lines. **meta** on the same header lists that round's token
and timing fields, plus session totals when those were recorded. The final
answer round always stays fully displayed. Tool descriptions in the config
view start condensed to about 13 lines, with the same tint. Click the
description to expand it, and **click to condense** puts it back.

## Saving your work

Two stores with split roles:

- **Browser `localStorage`** (toggle under **⋯ session options**, on by
  default): the working set — prompt, model thinking, responses, metrics,
  and the tool calls, raw previews, and tool results for each round.
  Refreshing this same tab restores that evidence, in the order it was
  recorded. A new launch, or opening the page after the window was closed,
  starts on a clean session. Recorded runs stay in history. The prompt box
  keeps a separate snapshot in this browser: Restore puts the last
  non-empty prompt back, and a clean session does not load it on its own.
  At most 20 tabs are kept (oldest pruned first, with a note).
  Formatted responses, syntax highlighting, and math rendering come back
  with the tab. Older saved responses are re-rendered from their original
  text locally by the harness server; no model call is made. When a tab is
  too large for browser storage, the tool text is left out of that copy
  and filled back in from the history database on the next load, using the run id
  stored with the tab.
- **Local SQLCipher** (default `$XDG_DATA_HOME/harness/harness.db`, or `~/.local/share/harness/harness.db`): the permanent record — absolutely
  every recorded run is stored with prompts, thinking, responses, tool
  calls *and* outputs, redirects, and metrics. The file is SQLCipher
  (AES-256 page encryption), not an ordinary SQLite database: a copy is
  unreadable without `HARNESS_DB_KEY`. The passphrase is not stored in
  the file. RAG corpora (`*.rag.db`) are separate and stay ordinary
  SQLite. The **history** button (top row) lists past sessions by
  auto-title and date; each opens read-only with JSON/HTML export, shows
  which files were uploaded (hover the file icon), and can be deleted to
  conserve disk. History never feeds back into the model. The database
  (and its write-ahead log) is created private to your user account
  (`0600`): transcripts hold everything the model read. Deleted space is
  reused inside the file; the file itself is compacted once a tenth of
  it has been freed (and at start-up), not on every delete. Compaction
  rewrites the encrypted file; it does not write a plaintext copy.

If the database cannot be opened, or a write fails later, the page shows a
banner with the reason and **Generate** stays refused. A wrong
`HARNESS_DB_KEY` (a keys file whose passphrase does not match the database)
is that kind of failure; with no passphrase anywhere the harness runs
session-only instead (see **Keys**). The banner does not include the
passphrase. Check **Allow an unrecorded run** to start a session anyway.
That box starts unchecked each time the page loads. A run already in
flight continues, and its transcript says that history stopped recording
it. Later runs stay refused until you allow another unrecorded session or
history is recording again (restart the harness after fixing the
database).

**New session** clears every tab and starts blank. If any completed content
hasn't been downloaded yet, a confirmation dialog warns you first.

## General-purpose fork

The Godot documentation importer, local RAG search tool, embedding client,
RAG routes, and Godot DB browser view from the original Godot-focused
harness have been replaced by a modular, corpus-agnostic RAG path described
below; no embedding model ships with the harness, and the permanent
session history remains in use without a schema change. The
file format is SQLCipher; the tables are unchanged. The
built-in tools are `run_cmd`, `ask_user`, `web_search`,
`web_fetch`, `read_pdf`, and the per-corpus search tools generated from any
`.rag.db` in the workspace root (see below); JSON tool specs provide the
extension point for other use cases.

## RAG corpora and tool selection

Any SQLite corpus in the workspace root whose filename ends in `.rag.db` and
whose `rag_meta` table declares `embedding_model` and `dims` is recognized at
startup and registered as its own tool — a `mydocs.rag.db` with `name:
'mydocs'` in its meta becomes `mydocs_search`. **No corpus ships in this
repository:** bring your own, or build one with the reference builder
(`tools/build_rag.py`), which indexes Markdown/text trees (headings become
sections) or JSON/JSONL record sets such as Hugging Face dataset slices
(`--text-keys` picks the fields to embed, `--title-key` names each record,
`--context-keys` stamps short fields like severity onto every chunk), then
embeds through your local Ollama embedding model and writes a corpus in
exactly the schema the harness validates. The harness itself stays
formless here — the driver model can write a bespoke builder for your
project against the same documented schema; `tools/build_rag.py` is the
reference implementation of it.

Each corpus is an ordinary tool — **checkable in the ⚙ config view** like
every builtin — which applies to the next new session (the loading model
switch doesn't touch a run in flight; it too is gated). Disabling a corpus
tool drops it from `tools[]` entirely on subsequent runs. The corpus file
stays read-only.

- **`<corpus>_search`** — semantic search over that corpus with the same
  two-stage gate as `read_pdf` text mode: stage one approves the query
  (embedding + dot-product ranking happens), stage two opens the wide
  review dialog with the retrieved chunks for curation, and only the
  submitted text reaches the model. `k` is capped at 10; `kind` optionally
  filters to text / code / table / image. Results carry source attribution
  (`title · source_path · kind`).

**⚙ config view** now shows a checkbox per registered tool. Everything else
(the JSON, the file-custom list, the model/system-prompt/workspace header)
stays read-only — the checkbox is the only mutation, and it only affects
the next run: a run in flight keeps its start-of-run set, the model and
tools are captured together at run start. The tool selection (including the
Allow all / approve menus) persists in
`$XDG_CONFIG_HOME/harness-tools.json` (or `~/.config/harness-tools.json`)
and is loaded at startup, so a tool you turned off stays off across
restarts until you turn it back on. `project_mem` is the exception: it is
always off at launch and must be enabled each time. A name in the file that
is not registered this launch (a custom tool run without its `--tools` file)
is dropped, and an unreadable file falls back to the all-on default.

## Exports

**Export** in **⋯ session options** opens Text, HTML, JSON, and All JSON:

- **Text** — the visible tab as context blocks.
- **HTML** — full fidelity including tool outputs, as a static page viewable
  offline with no server (`file://` safe).
- **JSON** — the visible tab: prompt, thinking, responses, metrics,
  registered tool names (tool outputs excluded; small files).
- **All JSON** — every open tab in that same lean format.

A recorded session's **Export** menu is Text, HTML, and JSON for that session.

## Custom tools

Beyond the built-in shell, question, and web tools, extra tools can be registered at startup from
plain JSON files — no recompilation:

```sh
cargo run -- --tools ./examples/extract_tool.json
```

(Note the `--` separator: everything after it goes to the harness, not cargo.)

Each file names the tool, its description, the executable script/binary, an
argv template with `{placeholders}` filled from the model's arguments, and a
verbatim JSON Schema for the parameters (see `examples/extract_tool.json`).
Startup validates everything fail-fast: reserved/duplicate names, missing or
non-executable binaries, and argv placeholders without matching schema
properties all abort with a naming error.

Custom calls go through the same approval dialog, 30-second execution limit,
and transcript as `run_cmd`.

The intended workflow is premeditated: write the parsing/extraction script
and its JSON spec beforehand, register them at startup, then ask the model
to use the tool on the appropriate data. Deliberate tool design beats
automated tool creation for accuracy — the model studies fixed, known
input/output relationships instead of fine-tuning its own tooling mid-task.

The pinned **⚙ config** tab shows the registration (system prompt,
model, round limit, and the full `tools[]` JSON) as sent to the model on every
call — read-only proof of what the model is aware of. Those sentences are
the text in `src/model_voice.rs`. The system-prompt
line writes this launch's comment marker as `<user_comment>` so the
12-character key stays in the live curation box.

## Trust boundary

`run_cmd` executes with your full user privileges, and its working directory
is this repository. That means an approved command can modify tool code,
custom-tool scripts, `web_tool/`, or the source tree. The history database
is outside the workspace by default, so `git clean -fdx` in the repo does
not delete it. A command can still reach that file by its absolute path.
`*.rag.db` corpora stay in the workspace root; they are the search tools'
input, not per-user session state. Treat the workspace as agent-writable:
keep tool implementations in a trusted location outside it where possible,
review commands before approving them, and restart after intentional tool
updates. The harness snapshots
registered custom-tool executables and the web-tool source/lock/entrypoint at
startup and refuses to run them if they change mid-session, but it cannot
protect code that was already modified before startup.

## Files

Backend (`src/`, one concern per module):

- `main.rs` — wiring only: CLI → tools → state → routes → serve.
- `auth.rs` — request authentication: launch token, host allow-list,
  same-origin check.
- `config.rs` — limits, CLI parsing, workspace and role settings, plus
  the re-export surface for the split modules. The system prompt is
  assembled here from `model_voice.rs`.
- `models.rs` — model identity and predicates, the Ollama model lists,
  and the context-window resolver.
- `page.rs` — the single page: compiled-in assets, launch token, nonce,
  comment key, and the page handler.
- `state.rs` — approval types, the pending-approval map, stop flags, and
  `AppState`.
- `model_voice.rs` — sentences the model reads (system prompt, tool descriptions, protocol notes). Edit this file to change how the harness speaks. `{comment_tag}` and `{workspace}` are filled each launch.
- `tools/run_cmd.rs` — the compiled-in shell tool.
- `tools/write_file.rs` — the code-writing tool: write/edit modes,
  before/after preview, atomic writes.
- `tools/capture.rs` — bounded child-process capture (output cap,
  process-group kill, no inherited stdin).
- `tools/web.rs` — search/fetch schemas and manual result validation.
- `tools/ask_user.rs` — question/note registration and answer validation.
- `tools/registry.rs` — JSON tool specs: validation, argv expansion, execution.
- `history.rs` — permanent SQLite session records and event replay.
  `GET /history` lists them newest-first and takes an optional `?limit=N`
  cap (default unbounded); the per-run reads stay unbounded because
  export and continue need full content.
- `harden.rs` — re-exec when the keys were in the starting environment, and mark the process non-dumpable.
- `keys.rs` — encrypted `harness-keys` file. The startup password is typed each launch.
- `markdown.rs` — model-response markdown conversion + HTML sanitizing.
- `stream.rs` — NDJSON protocol and the tool-calling loop.
- `server.rs` — `/generate`, `/approve`, `/config`, `/stop`, and `/history` handlers.

Frontend (`web/`, one served page). A `cargo run` debug build reads these files on each request, so a browser refresh picks up script and style edits. A release build keeps the copies compiled into the binary:

- `index.html` — markup with `/*__APP_CSS__*/` / `/*__APP_JS__*/` slots.
- `style.css` — all styles.
- `js/` — plain scripts, no bundler. `WEB_JS_FILES` in `src/page.rs`
  is the load order and the module contract: core, icon, tabs, vim,
  modelmenu, rounds, subtabs, prompt, approval, the Prism grammars and
  KaTeX, highlight, stream, scroll, storage, history, boot. A test pins
  the on-disk web sources to the compiled-in copies, so the two lists
  cannot drift apart.

Tool outputs are capped at 4 MB per stream (RAG at 256 KB, PDF text at
256 KB) with explicit truncation markers; chains run to natural completion
(no round cap — the approval gate is the bound, and **Stop** ends a run at
any point).

## Development

Three test suites. Run them before pushing:

```sh
cargo test -- --test-threads=1
```

The Rust suite must run single-threaded. Several tests manipulate
process trees — the harden re-exec, the sudo reaper, and the pid-namespace
supervisor — and under parallel execution a group kill from one can take
down the shared test runner. Single-threaded, the whole suite is green
(225 tests, ~25 s).

```sh
web/js/run_tests.sh
```

The frontend suite: seventeen standalone Node scripts with their own
fake DOM. No package.json, no bundler; the runner executes each file
and reports one line. These tests assert behavior and data, never
display wording — the UI's sentences are surface you reword freely, so
a text assertion is legitimate only where the text is the function
(the model's own command in a dialog, protocol markers like
`<user_comment>`, the CLOUD egress badge). See the header of
`run_tests.sh`.

```sh
uv run --locked --no-sync --project web_tool python -m unittest discover -s web_tool/tests
```

The Python web-tool suite (run `uv sync --project web_tool` first when
the venv is missing or stale — the tests import `ddgs` and `playwright`
and will all error against a broken venv).

## Prompt editor and context protocol

The prompt editor is for curating large contexts. On a screen about 960px
wide, **prompt edit** expands the box in the column and collapses it
again. History replaces that column until you return. On a wide screen
(1920px and up) that control is not shown. The prompt opens in the
left lane while the page is idle,
and it stays there while you browse history, expand rounds, and curate.
**Generate** clears that lane so Thinking, Waiting for response, and tool
approvals can use it, with the session column on the right. When the run
ends, the prompt lane returns with the prompt box cleared. Under the
prompt box, on either width, **Save**, **Compact**, **Clear**, and
**Restore** sit on the left beside the vim keys switch and the character
count. **Upload files** and **Generate** sit on the right, **Upload
files** first. **Stop** stays on the session tab row. The editor has
**Save**, **Compact**, **Clear**, and **Restore**. Save writes the prompt
box to a file through the browser. Compact replaces the selection with
`[ctx compacted]`. A block header that includes `HID: N` still addresses
that body in session history (`events.id`). Selecting the marker recalls
the row. Copy stays a browser key. Clear stores
that text in this browser and then empties the box. Restore puts the stored
text back and leaves it stored. While you edit, that copy refreshes after
about 3 seconds of inactivity, and again if the page closes, unless
Prompt autosave is off in Config. An empty box
does not erase it. The editor also has
character/line counters, and **Upload files**
(text only, 1 MB each), inserted as:

```
---- Uploaded File 'notes.txt' ----
(file contents)
---- EOF 'notes.txt' ----
```

`====` markers are CHAIN relays (`PROMPT`, `THINKING`, `TOOL CALL/RESULT`,
`RESPONSE`, `CONTEXT BUDGET`); `----` markers are file inserts — keep the
hierarchy so the model can tell pasted structure from file content.
Curate assembles the model-bound lineage in this format (token/time
metrics and before-review originals excluded; per-call timing inside tool
results kept verbatim) for pruning into the next prompt. Each history
event carries a `to_model` flag derived from its type: `prompt`,
thinking, content, tool calls, tool results, and context-budget
notifications are model-bound; originals, approvals, metrics, notices,
and corrections never are. The provider copy omits before-review
captures entirely — no placeholder is left, so the copy's HID sequence
skips. A block whose body the person compacted to `[ctx compacted]` is
omitted the same way: the marker is a curation-phase notation and is
never sent during a Generate run. `CONTEXT BUDGET` blocks are part of
the lineage (pacing notifications at 20/40/60/80/90/96% fill) and stay
in the copy; this run appends its own fresh budget line at the end of
the request. Export and the history view keep every block. Grok requests
send `x-grok-conv-id` set to the run id so prefix
caching stays on one server. Reflection does not use that header; it
receives `Reflection-Missing-Reasoning-Strategy: auto` so a turn with no
reasoning trace is accepted without inventing one. Ollama requests set
`keep_alive` to 30 minutes so an approval pause can reuse the prefix cache. On a wide screen
the prompt stays editable while config or credits is open on the right.

---------------------------

Copyright (c) 2026 MIT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
