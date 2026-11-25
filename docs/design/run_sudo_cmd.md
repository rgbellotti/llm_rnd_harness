# `run_sudo_cmd` — design

> **Deprecated, implementation removed.** This tool was replaced by
> `run_sudo_cmd_relay`, which proposes a root command and lets the person run
> it in their own terminal and paste the output back, so the harness never
> handles a password. The askpass implementation (askpass helper, pid-namespace
> supervisor, password slots, and the approval-dialog password flow) was later
> deleted from the tree; this document and the git history are the design
> record. The one live piece that shipped with it — the `elevation_token`
> speed-bump that flags `sudo`/`su`/`pkexec`/`doas` in `run_cmd` — now lives in
> `src/tools/elevation.rs`.

The harness implements this design. The open questions at the end record the choices that were changed before implementation. The status of the re-review findings is in [docs/security/run_sudo_cmd_open_findings.md](../security/run_sudo_cmd_open_findings.md).

`run_sudo_cmd` is a new built-in tool. The model asks to run one shell command as root. The person at the keyboard approves that command, types a sudo password only when sudo actually asks for one, and then reviews the output before any of it is sent back to the model. Nothing in this design turns that into a setting that can be switched off.

The harness this fits is the one in this repo: a local, single-user page on `127.0.0.1`, a per-launch token, NDJSON (newline-delimited JSON) on `/generate`, and a dialog that waits with no deadline before any tool runs. `run_cmd` goes through `src/tools/capture.rs`. History is a SQLCipher file. API keys live in an age-encrypted `harness-keys` file. `src/harden.rs` re-execs once so those secrets are not in `/proc/<pid>/environ`, then sets the process non-dumpable. The page is one HTML document with plain scripts, no bundler.

Checked while writing this, on sudo 1.9.15p5 with `Defaults use_pty` and a `NOPASSWD: ALL` rule for the invoking user:

- `sudo -n cat` with a secret on stdin printed that secret. Closing stdin printed nothing.
- `sudo -A` did not run the askpass helper, because no password was required.
- `sudo -n -D /tmp pwd` and `sudo -n --chdir=/tmp pwd` were refused: `you are not permitted to use the -D option`.
- A child environment built by sudo's normal `env_reset` did not contain `XAI_API_KEY`, `HARNESS_DB_KEY`, or `HARNESS_TOKEN`. The same command with `sudo -E` did contain the API-key probe. `env_reset` still kept `PS1` and `DISPLAY`, so it is not a full wipe.
- Killing sudo's process group with `SIGKILL` (the signal `capture.rs` sends today) left a root `sleep` running, reparented to pid 1. The user could not signal it (`EPERM`). `SIGTERM` to the sudo process killed a foreground `sleep`, and did not kill the children of a root shell, including a `setsid` sleep.
- A small supervisor that creates a new pid namespace (a private process-id space) and sets a parent-death signal did kill the shell, the background sleeps, and the `setsid` sleep, for `SIGTERM` to sudo, `SIGKILL` to sudo, and `SIGKILL` to sudo's process group.

Those observations are why the mechanisms below are the ones to build, not a thinner wrapper around `capture.rs`.

## What this design keeps

- Approvals stay explicit. A root call cannot be put on Allow all.
- Tool output stays reviewable. Root output always stops in the review dialog.
- History stays out of the model until the person curates it into a new prompt and sends that prompt.
- The page stays one document. The new controls live in the approval dialog and the existing tool row.
- Cloud versus local stays visible. A root review says, in the open, whether the active model will send the submitted text off this machine.

Ease of use is the existing dialog, plus one password box when sudo will actually ask, plus the tool checkbox that is already how tools are turned on. There is no second page, no sudoers file to edit, and no password file.

## Decisions at a glance

| Topic | Choice |
| --- | --- |
| Tool shape | New tool `run_sudo_cmd`. Not a `sudo` prefix inside `run_cmd`. |
| When it is offered | Registered, and off until this launch's tool checkbox is turned on. Off again on restart. |
| Call approval | Always. Reject the name from Tool Calls → Allow all. |
| Output review | Always, including empty output. Reject the name from Tool Outputs → Allow all. Ignore the `run_cmd` review checkbox. |
| Password | Askpass helper (`sudo -A`). Command stdin stays closed. Never `sudo -S`. |
| Cached sudo ticket | `sudo -k` on the same command, so this call neither uses nor refreshes a ticket. |
| Stop and timeout | A non-setuid reaper in front of sudo, then a root supervisor in a new pid namespace. `SIGTERM` the reaper, which `SIGKILL`s sudo's group. Never `sudo -b`. |
| Working directory | Fixed `cd` script with the launch directory as its own argument. Do not use `sudo -D`. |
| Environment | `env_clear` on the sudo process, then a short allowlist. Never `-E` / `--preserve-env`. |
| What the model sees | Only the text the person submits, or the usual interrupt text if they redirect. |
| What history keeps | The raw capture only if they check "keep the full root output". The checkbox starts unchecked. The password is never stored. |

## How the current harness behaves

`run_cmd` (`src/tools/run_cmd.rs`) runs `bash -c` with the model's command as one argument. The working directory is `WORKSPACE_DIR`, captured and canonicalized at startup. Stdin is closed. The capture cap is 4 MB per stream, applied while the process runs. On timeout, on hitting the cap, and when the capture future is dropped (Stop, disconnect, process shutdown), `capture.rs` sends `SIGKILL` to the child's process group. That works for an ordinary shell because the user is allowed to signal every process in that group. It does not work for root, which is concern 3.

There is no command deny-list. An earlier substring filter was removed because it was easy to bypass and looked safer than it was. The dialog is the control. This design does not add a new deny-list.

Two switches can skip a review today, and both must be powerless for this tool:

- **Review `run_cmd` output** (`review_run_cmd`, on at launch). When it is off, `run_cmd` output goes straight to the model.
- **Tool Calls → Allow all** (`approve_calls`) skips the call dialog and the output review. **Tool Outputs → Allow all** (`approve_outputs`) skips only the output review, and only while calls are still Approve only. `skip_output_review` in `src/stream.rs` is true if the name is in either set. `ask_user` is already refused from both sets.

The output review that does run is `CmdReview`: the capture is streamed as a `tool_preview`, the dialog opens on that text, and only a non-empty `web_result` (or a redirect) becomes the `tool_result` the model reads. The raw preview stays in history and in the HTML archive. JSON export leaves tool outputs out. Continue-in-new-tab copies both the preview and the result into a prompt the person can prune; it does not send that prompt by itself.

Cloud models are `is_cloud_model` in `src/config.rs`: the published `:cloud` tags, any installed tag ending in `:cloud`, and every Grok model. The selector groups are OLLAMA, LOCAL, and GROK. The approval dialog already shows `CLOUD — prompts and tool outputs leave this machine` while a cloud model is selected. That line is quiet. Root output needs a louder one next to it, not instead of the rule that local and cloud look different.

Provenance (`provenance_notes` in `src/stream.rs`) warns when the command text appears verbatim in a page, search, PDF, or corpus result already read in this run. The warning is advisory. The command still runs only after Accept.

History (`src/history.rs`) stores every labeled event and has no path back into the model. Deleting a run deletes its events. The page token, `XAI_API_KEY`, and `HARNESS_DB_KEY` are not written there. `harden.rs` is explicit that root, or `CAP_SYS_PTRACE`, can still read the harness process. A root command can print those secrets. Output review is what stops that print from becoming the next prompt.

## 1. Root output and the model

### Chosen mechanism

`run_sudo_cmd` always has two dialogs.

1. **Call dialog.** The raw command, the task phrase, the timeout, provenance, and the cloud/local banner. Accept runs it. Edit Command runs the edited text and can attach a note for the model (the note is not passed to the shell, same as `run_cmd`). Alternate Tool Call does not run it.
2. **Output dialog.** Opens after the process has ended or been killed, including when the capture is empty or only a timeout note. The person edits, trims, comments, or replaces the text, then **Approve & submit content**. Redirect sends alternate instructions and does not send the capture.

The tool loop must not consult `review_run_cmd`, `approve_calls`, or `approve_outputs` for this name. `set_tool_policy` drops `run_sudo_cmd` from both allow-sets even if a client posts it, the same way it already drops `ask_user`. The Tool Calls and Tool Outputs menus on this row are fixed on Approve only and cannot be changed. `automatic_submitted_output` is not used. An empty capture is not a reason to skip the dialog: the person still has to submit a sentence such as "(no output)" or redirect. That keeps the cloud warning in front of them.

The model is appended one of two things, and nothing else:

- The exact submitted string, as the tool result. Same rule as command review today: a bare string, not a JSON-encoded string.
- The existing interrupt text (`TOOL_CALL_INTERRUPT`) if they redirect.

The exit code stays on the history event and off the model text, as it does for `run_cmd`.

### Cloud and local

Both dialogs say which kind of model is active.

- Cloud (`is_cloud_model`): a high-contrast banner, not the quiet gray line. Wording: `CLOUD — this model is not on this machine. Root output you submit is sent to the provider.` The quiet line the other tools use can stay above it so the phrase stays recognizable.
- Local: `LOCAL — root output stays on this machine unless you export it or continue it into a new prompt.`

The banner is computed from the run's model, which is fixed at run start. It is not a checkbox.

### What is stored

| Place | Password | Raw root capture | Text the model was given |
| --- | --- | --- | --- |
| Next model request | No | No | Yes, the submitted string or the interrupt |
| Live transcript | No | Yes, until they withhold it | Yes |
| SQLCipher history | No | `tool_preview`, unless withheld | `tool_result` |
| HTML export | No | Yes, if the preview was kept. The archive header says the file contains root output | Yes |
| JSON export | No | No (tool outputs stay omitted) | No |
| Browser `localStorage` | No | Only after the review decision, and only if kept | Yes, as part of the session |
| sudo's own auth log | No | No | The command line, not the output. See concern 5 |

The preview write waits until they decide. Today `run_cmd` records `tool_preview` before the dialog, and the page persists on a timer, so a withhold checkbox would be a lie if the bytes were already in history and in `localStorage`. For this tool:

- The dialog holds the capture. It is not pushed into `toolPreviews` and not written to history while the dialog is open. `persist()` skips a sudo preview marked provisional.
- **Keep the full root output in history and in this transcript** starts unchecked. The raw capture is stored only when the reviewer checks it. Submit then writes that raw `tool_preview` and the submitted `tool_result`.
- Unchecked, the `tool_preview` payload is the fixed sentence `Root output withheld from history by the reviewer.` The `tool_result` is still whatever they submitted, which may be a trimmed copy. The live transcript stores the same placeholder, so HTML export and a later history replay do not bring the raw bytes back.
- Redirect is the decline. The model gets the interrupt, not the capture. The keep checkbox still applies to the preview and still starts unchecked, so a decline does not leave the raw capture unless they check the box.
- Stop, disconnect, or a closed approval channel before they choose writes the raw preview and an aborted run, matching history's "store what happened" rule. They did not get to withhold it. The model is not given the capture.

Curate and Continue behave as they do now. Continue copies kept previews and tool results into a draft prompt. The person prunes, then presses Generate. A cloud model receives that draft only if they send it. The continue hint should name root output when the draft contains a `run_sudo_cmd` result or a kept preview.

### Redact and decline, in the dialog

- **Redact what the model sees:** edit the review box. Comments use the existing per-launch comment marker. The marker is not the password and not the page token.
- **Decline to send it:** Alternate / redirect, with non-empty instructions. Empty redirect stays an error, as it is today.
- **Decline to keep it locally:** uncheck the keep box before submit or redirect.
- There is no third choice that deletes some other run's history. Deleting the whole run remains the history view's existing delete.

### Rejected alternatives

- **Reuse the `run_cmd` review switch.** Rejected because that switch is defined as optional and starts overridable. Root output is the case that must not be optional. A shared flag would also surprise someone who turned the switch off for ordinary shells.
- **Allow all for calls or outputs.** Rejected because Allow all for calls already skips both dialogs, and Allow all for outputs skips the second one. Putting root on either menu is an off switch with a mild name.
- **Auto-submit empty output.** Rejected because the empty result is still "this root command finished" and the cloud banner would never appear.
- **Record the raw preview immediately, then try to overwrite it.** Rejected because history events are append-only and the page persists the stream as it arrives. A later "please forget that" event is easy to miss in HTML export, `localStorage`, and an open replay.
- **Keep root output only in the dialog and never in history.** This is the default. The reviewer checks the box to keep a capture. Stop before a choice still stores the raw preview, because they did not get to withhold it.

## 2. Password handling

### Chosen mechanism

Never `sudo -S`. Never write the password to the command's stdin. The command is spawned with stdin closed (`Stdio::null()`), same as `capture.rs`.

sudo is invoked as `sudo -k -A -- …`. `-A` tells sudo to run the askpass helper and read the password from that helper's stdout. `-k` (`--reset-timestamp`) on a command tells sudo to ignore a cached ticket and not to write a new one. A later call in this launch, and a sudo in the person's own terminal, do not become passwordless because this tool succeeded. A separate `sudo -k` or `sudo -K` after the command is not run: `-K` clears every ticket for the user, and a bare `-k` clears "this session" in a way that depends on `timestamp_type` and can hit the terminal they still want.

### When the box is shown

Before the call dialog is shown, the server probes with `sudo -n true` (non-interactive, no command from the model, stdin closed). The probe is not a tool call and is not sent to the model.

- Exit 0: this policy will not ask. The dialog says so: `sudo will not ask for a password. A NOPASSWD rule authorizes this, not a password you type.` There is no password field. Any password already typed is wiped.
- Non-zero, and stderr is the ordinary "a password is required": show one `<input type="password" autocomplete="off" spellcheck="false">` on the call dialog, next to the command. Accept stays available for an empty field only because some policies have an empty password; a rejected password comes back as sudo's own error, through the output review, and the password is not in that error.
- Non-zero for any other reason (`sudo: a password is required` versus not permitted, no such command, unreadable sudoers): the dialog shows that stderr and does not run the model's command. Alternate is still available.

The probe runs again at Accept, immediately before spawn. A policy that flipped to NOPASSWD between the two probes does not receive the typed password: the field is wiped, `-n` is passed, and the output review includes the sentence `sudo did not ask for a password. A NOPASSWD rule authorized this call.` A policy that flipped the other way, with no password collected, does not spawn; the field is shown and nothing has run.

### How the password moves

sudo's askpass child closes every file descriptor numbered 3 or above before it execs the helper (`closefrom` in `src/tgetpass.c`). An inherited pipe on fd 3 will not be there. The helper's stdin is sudo's stdin, so the password cannot be placed on sudo's stdin either: under NOPASSWD the helper never runs, and `cat` would print the pipe. That was observed.

The channel that survives `closefrom` is a connected socket, and the password is sent only after the server checks who connected.

1. The harness binds a Linux abstract socket (a socket whose name is not a filesystem path) named `harness-askpass/` plus 128 bits from `/dev/urandom`.
2. `SUDO_ASKPASS` is this binary. There is no shell script. A same-uid process used to be able to rewrite a `0700` script so that `exec` kept sudo as the parent and the password was redirected into the attacker's file. Pointing sudo at the binary removes that file.
3. The socket name is not an argv element. `/proc/<pid>/cmdline` is world-readable. The reaper forks sudo and then drops `HARNESS_ASKPASS`, `HARNESS_ASKPASS_SOCK`, and `SUDO_ASKPASS` from its own environment and sets itself non-dumpable. The child that becomes sudo keeps the two askpass variables so the helper can inherit them. `/proc/<pid>/environ` is not readable across uids, and it is not readable for a non-dumpable process. The name is a capability to attempt a connection, not the password. sudo's `env_reset` does not forward those names to the root command.
4. sudo, if it needs a password, execs this binary. The early dispatch enters askpass only when both variables are set, argv has no `--` flag, and the socket name matches `harness-askpass/` and is at most 80 bytes. That path runs before key loading, before the re-exec in `harden.rs`, and before the HTTP server.
5. The helper's first action, before it opens a socket, is `PR_SET_DUMPABLE` 0, `PR_SET_NO_NEW_PRIVS`, `RLIMIT_CORE` 0, and `PR_SET_PTRACER` 0 when the kernel has Yama. It then refuses to continue if `/proc/self/status` shows a tracer. It `fstat`s stdout, connects, and sends that device and inode. After it has read the password it `fstat`s stdout again and writes the password only if the inode is unchanged and it is still not traced.
6. The password is sent only if all of these hold. Any other connection is closed. The server keeps waiting until sudo's helper connects or sudo exits.
   - `SO_PEERCRED` uid is the invoking user.
   - `stat` of `/proc/<peer>/exe` returns `EACCES`. A still-readable exe means the helper has not locked itself, and the password is not sent. After that lock the same user cannot compare the inode, so the parent, tracer, and fifo checks are what identify the helper.
   - `TracerPid` in `/proc/<peer>/status` is 0. That file stays readable. A tracer cannot hide it from the server.
   - The peer's direct parent is the sudo pid the reaper reported on the pipe.
   - The device and inode the helper sent are a fifo that sudo is holding. A redirect to a regular file does not match.
   - The peer's cmdline does not already contain the password. Environ is unreadable once the helper is non-dumpable; if it is readable and contains the password, the server does not send.

The abstract socket is closed when the helper returns or sudo exits.

### Where the password must never go

- Not in the tool schema, the command string, the task phrase, the note, or the edited command.
- Not in argv of sudo, the supervisor, the shell, or the command. `/proc/<pid>/cmdline` would show it.
- Not in the environment. `/proc/<pid>/environ` would show it, and `sudo -E` or an `env_keep` rule could copy it into the root process.
- Not in stdout, stderr, the timeout note, or a spawn error.
- Not in the approval record, `tool_preview`, `tool_result`, the NDJSON event, the HTML archive, or the system prompt.
- Not in `localStorage`, the prompt box, or prompt autosave. The field is not a session field. It is cleared from the DOM on submit, redirect, Stop, and when the dialog closes.
- Not in a URL or a query string. The POST body of `/approve` carries it under a dedicated field. `record_approval` must not receive that field. The process does not log request bodies; this route must not grow a body log.
- Not retained for the next call. One password, one command, then wipe.

The POST is loopback HTTP plus the launch token, which is the harness's existing request boundary. There is no TLS on this port. A process without the token cannot post. That is the same boundary as every other approval, and it is acceptable here because the password never leaves the machine except into local sudo.

### Zeroing memory

Rust's `String` does not wipe its bytes on drop. The password is held in a `Zeroizing<Vec<u8>>` from the `zeroize` crate once it has been taken out of the request. `/approve` reads the body as `Bytes`, copies it into a `Vec`, parses that, then volatile-zeros the `Vec` and, when `Bytes::try_into_mut` succeeds, the original buffer. The `String` serde built for the field is zeroized when the password is taken. A `Bytes` buffer that hyper still shares cannot be made unique, so that copy is not wiped; the owned `Vec` and the `String` are. The type does not implement `Debug` or `Display`. `secrecy` would also hide `Debug`; it is not added. One crate is enough if `Debug` is simply not implemented.

The page's JavaScript string cannot be wiped. The field is cleared before the value is copied. The object property is deleted immediately after `JSON.stringify`. The local that held the JSON is set to an empty string after the request returns, including on failure. The body is not logged and is not stored on the session. The string and the browser's copy of the request body can remain until the engine collects them. That residual is accepted.

Wipe on every path: successful send, rejected peer, probe discovered NOPASSWD, validation error, Stop, disconnect, and drop of the approval slot.

### NOPASSWD

Detected only by `sudo -n true`, not by parsing sudoers. The dialog states that a typed password is not what authorizes the command. The implementation must not claim "authenticated with the password you typed" on that path. `-k` is still passed. It is a no-op for the password and still avoids refreshing a ticket on policies that mix the two.

### Rejected alternatives

- **`sudo -S`.** Rejected because `-S` reads the password from sudo's stdin, and the command inherits that stdin when sudo is not using a separate tty. Observed: `sudo -n cat` printed the bytes that were queued. NOPASSWD never consumes them, which is the worst case, not an edge case.
- **Password on an inherited fd.** Rejected because askpass `closefrom`s fds above 2 before exec, so the helper would see end-of-file, and a fd that stayed open on the command side is another copy of the `cat` bug.
- **Password in `SUDO_ASKPASS` argv, the environment, or a `0600` file the helper cats.** Argv is world-readable. A file in the runtime dir is readable by the same user for as long as it exists. The socket name is in sudo's environment, which is not world-readable, and the password itself is not. The socket plus the peer check does not hand the bytes to whichever process opens a path first.
- **A writable askpass script.** Rejected. A same-uid process can rewrite a `0700` script during the window, add a stdout redirect, and `exec` the real helper so the parent is still sudo. `SUDO_ASKPASS` is this binary.
- **A graphical askpass (`ssh-askpass`, `systemd-ask-password`).** Rejected because this page is the UI, those helpers need a desktop session, and they do not know about the launch token.
- **Caching the password in the harness for the launch.** Rejected. sudo's own cache is already the tempting version of this, and `-k` is here specifically so one approval does not become a fifteen-minute root ticket.
- **`sudo -K` after each call.** Rejected because it revokes tickets in other terminals, which is a sharp edge for a tool that was only supposed to authenticate itself.
- **Leaving the default ticket behavior (no `-k`).** Rejected because the second root command in a few minutes would not ask again, including one the person expected to authenticate. The dialog would be lying if it showed a password box and sudo then ignored it.

## 3. Kill semantics

### What goes wrong with today's capture

`capture.rs` starts the child in its own process group and sends `SIGKILL` to that group. `SIGKILL` cannot be caught or forwarded. sudo's real uid stays the invoking user (observed: `Uid: 1000 0 0 0`), so the user can kill the sudo process. The root child is uid 0. The kernel delivers the group signal only to members the sender is allowed to signal, and skips the root child. The child is reparented to pid 1 and keeps running. A later `kill` from the user returns `EPERM`.

`use_pty` (sudo's default on this machine; a pseudo-terminal, a software stand-in for a terminal) is why this bites in practice. With it, sudo is documented to relay signals to the command, and a `SIGKILL` of sudo never gets the chance to relay. On 1.9.15p5 the root `sleep` was in sudo's session and process group, not in a new session, and it still survived `SIGKILL`. A design that assumes "same process group means `killpg` works" is wrong for root. A design that assumes "use_pty always `setsid`s" is also too narrow. Both shapes orphan the child if the only signal is `SIGKILL` from the user.

`SIGTERM` to the sudo pid is relayed. It killed a foreground `sleep`. It killed a root `sh` and left both of that shell's sleeps alive, including one started with `setsid` (a new session, which leaves the process group). So "send `SIGTERM` and trust sudo" is necessary and not sufficient. `sudo -b` (background) is never passed: the parent would exit on purpose and the relay would go with it.

The harness also cannot `SIGKILL` the root child itself. Any plan whose last step is "the user signals the root pid" does not work.

### Chosen mechanism

Every `run_sudo_cmd` process tree is:

```
harness
  reaper        (this binary, not setuid; parent-death signal = SIGTERM)
    sudo        (real uid = user; the kernel clears PDEATHSIG on this setuid exec)
      supervisor  (root, direct child of sudo; parent-death signal = SIGTERM)
        pid 1 of a new pid namespace
          shell → the approved command and any children, setsid or not
```

The harness does not exec sudo. It execs this binary as `--sudo-reaper -- <sudo path> <sudo argv…>`. sudo is setuid, and the kernel clears `PR_SET_PDEATHSIG` when credentials change across exec. A signal set in `pre_exec` immediately before exec of sudo does not stay on sudo. That was confirmed here: a process that set `SIGKILL`, exec'd `sudo -n sleep`, and was then `SIGKILL`ed left sudo reparented to pid 1 with the sleep still running. The reaper is not setuid, so a catchable parent-death signal survives. The child of the reaper still sets `PR_SET_PDEATHSIG=SIGKILL` and re-checks `getppid` immediately before exec of sudo. That covers the window before the image is replaced. It does not cover sudo itself.

`pre_exec` on the reaper sets `PR_SET_PDEATHSIG=SIGTERM` and re-checks `getppid` against the harness. The signal is `SIGTERM`, not `SIGKILL`: the reaper has to run a handler. The handler `SIGKILL`s sudo's process group (the child calls `setpgid` before exec) and the sudo pid, then exits. When the harness is `SIGKILL`ed, the kernel delivers `SIGTERM` to the reaper and that handler runs.

That handler does not run if a same-uid process `SIGKILL`s the reaper, or `SIGSTOP`s it and the harness then `SIGKILL`s it. A non-setuid pid namespace between the reaper and sudo cannot hold host-root sudo: an unprivileged user namespace can create the pid namespace, and host root can `setns` into it, but a further `unshare(CLONE_NEWPID)` from that host-root process returns `EINVAL` because the pid namespace belongs to the other user namespace. The supervisor therefore arms `PR_SET_PDEATHSIG=SIGKILL` on each sudo process between itself and the reaper, by stopping that process with `ptrace`, running `prctl`, and restoring its registers. sudo is the reaper's direct child, so the reaper's death delivers `SIGKILL` to sudo even when the reaper never runs a handler. The supervisor's own parent-death signal then tears the namespace down. If the arming fails, the command is not run. The user can signal sudo because sudo's real uid stays the invoking user. The root descendants are in sudo's process group, except a `setsid` child. Killing the group, or killing namespace pid 1, kills those descendants.

The reaper writes sudo's pid (the fork result, which is the host pid) as four little-endian bytes on fd 3 and closes it. Askpass checks that pid as the helper's direct parent. The probe `sudo -n true` is not wrapped in the reaper. It is short and does not run the model's command.

The supervisor is this same binary, `… --sudo-supervisor -- <argv>`. That mode is handled before keys and before the HTTP server. It is not a tool and it is not setuid. `unshare(CLONE_NEWPID)` needs root, which sudo has just provided. The reaper does not create a pid namespace: as the user, `unshare(CLONE_NEWPID)` returns `EPERM`. A user namespace around sudo would make the command root only inside that namespace, which is not the tool.

Supervisor rules:

- Set `PR_SET_PDEATHSIG` to `SIGTERM` immediately, then re-read the parent pid. If sudo has already died, exit. (`PR_SET_PDEATHSIG` is a Linux parent-death signal: the kernel delivers it when the parent exits, including when the parent is killed with `SIGKILL`, which cannot run a handler.)
- `unshare` a new pid namespace and fork. The child is pid 1 inside that namespace. Pid 1 sets its own parent-death signal to `SIGKILL`. Inside the new namespace `getppid()` is 0, so pid 1 does not compare that value to the outside parent.
- Before the command is forked, and before capabilities are dropped, pid 1 unshares a mount namespace and makes `/` private (`MS_REC|MS_PRIVATE`). It then mounts a fresh procfs over every proc mount. That procfs lists only pids in this namespace, so `/proc/<host pid>/root/proc/sys` is not a path to the host proc. It bind-mounts `/proc/sys` and remounts that bind read-only, because a new procfs still exposes the global sysctls. If any of those calls fail, pid 1 writes the error and exits 127. The command is not run. `/sys` is not remounted. A root command can still write `/sys` and can still do other root things. This tool is not a sandbox.
- Pid 1 forks the command. The command sets parent-death signal `SIGKILL`, drops `CAP_SYS_ADMIN` and `CAP_SYS_PTRACE` from its bounding set, then execs. Pid 1 stays in a wait loop so it outlives a shell that exits before its grandchildren.
- On `SIGTERM`, the outer supervisor `SIGKILL`s pid 1 and exits. When pid 1 dies, Linux `SIGKILL`s every other process in that namespace. That includes background jobs, `setsid`, and a new process group. It does not depend on the user being allowed to signal uid 0.
- The outer supervisor also `SIGKILL`s pid 1 if its own `SIGTERM` parent-death signal arrives because sudo was `SIGKILL`ed.
- As soon as the pid namespace exists, the supervisor drops every capability it no longer needs, including `CAP_SYS_ADMIN` and `CAP_SYS_PTRACE`, and sets `no_new_privs`. Failure of the ambient clear, a bounding-set drop (other than `EINVAL`, which ends the capability loop), `capset`, or `no_new_privs` is fatal: the outer supervisor `SIGKILL`s pid 1 and returns an error, and pid 1 `SIGKILL`s the command and exits 127. The process does not continue privileged. The approved command is forked before the supervisor's drop. `no_new_privs` is not set on the command: that flag would suppress the kernel's root exec fixup and strip the other capabilities a legitimate root command still needs. The supervisor processes, which only wait and signal, do set it.

This was checked with a throwaway supervisor of that shape: a root shell running `sleep`, a background `sleep`, and `setsid sleep` all died after `SIGTERM` to sudo, after `SIGKILL` to sudo, and after `SIGKILL` of sudo's process group. No root `sleep` remained.

Stop, timeout, the output cap, disconnect, and dropping the capture future all use one sequence, not `capture.rs`'s `kill_group`. The spawned pid is the reaper, not sudo.

1. `SIGTERM` the reaper. Its handler `SIGKILL`s sudo's process group and the sudo pid. The supervisor's parent-death signal then takes the namespace down if the group signal did not.
2. Wait up to 500 ms, on a helper thread, using `pidfd_open` plus `poll` (a short sleep only if `pidfd_open` fails). This does not call `std::thread::sleep` on a Tokio worker.
3. If the reaper is still alive, `SIGKILL` it. A stopped reaper does not run the `SIGTERM` handler; this `SIGKILL` still kills sudo, because sudo's parent-death signal was armed by the supervisor. The reaper's own parent-death signal is the backstop for a harness that is itself `SIGKILL`ed and cannot run this sequence.
4. Wait up to 500 ms the same way. Namespace teardown can lag the reaper's exit by a few milliseconds, so the survivor walk then polls for up to another 500 ms on that same helper thread.
5. Walk descendants recorded at spawn. If any process remains, do not hide it. The capture text includes `root process <pid> survived Stop and could not be signaled` and the command line from `/proc/<pid>/cmdline` if it is readable. The output review still opens on that text. The implementation test fails if this line appears.

`GroupState` in `capture.rs` stays the bookkeeping (armed flag, `/proc/<pid>/stat` start time so a recycled pid is not signaled). The kill function for this tool is the sequence above. Reusing `kill_group`'s immediate `SIGKILL` as the only step is not allowed. In the probe that `SIGKILL` did take the namespace down, but only because sudo died and the parent-death signal fired. The sequence still has to `SIGTERM` first, so a sudo that is able to relay can exit cleanly, and the survivor check still has to run.

The race before the supervisor sets the parent-death signal is a few milliseconds and is before exec of the command. The re-check of the parent pid closes it for the supervisor itself. A test spawns and Stops in a loop.

Interactive programs do not work. The harness allocates no terminal. Stdin is closed. sudo may still allocate its own pty because of `use_pty`; nothing is typed into it. A program that reads stdin gets end-of-file. A program that needs `/dev/tty` fails. The call dialog says that. The tool description says that. Do not allocate a pty to "make vim work"; a pty is how a password and a root command end up sharing a terminal.

### Rejected alternatives

- **`kill_group` `SIGKILL` alone.** Rejected. Observed to orphan a root `sleep` on the sudo this harness would be talking to.
- **`SIGTERM` to sudo alone.** Rejected as the whole plan. It does not kill a shell's children or a `setsid` child, and a `SIGKILL` from Stop (today's drop path) never gives sudo a chance to relay.
- **`unshare --pid --fork --kill-child` in front of the command, without a parent-death signal.** Rejected. Observed: `SIGKILL` of sudo left `unshare` and both sleeps alive, because `--kill-child` is a handler in `unshare` and `SIGKILL` does not run handlers. `SIGTERM` of sudo was not enough to tear that tree down either.
- **`sudo -b`.** Rejected. It detaches on purpose.
- **A user-namespace sandbox that drops root.** Rejected as the kill mechanism. The tool exists to be root. The namespace here is only a kill boundary. A hostile command can still try to leave it; see the threat model.
- **Asking the person to run `sudo kill` by hand as the normal Stop path.** Rejected as the mechanism. It is the recovery instruction in the survivor message, not the way Stop works.

## 4. Environment and working directory

### Chosen mechanism

The sudo process is spawned with `env_clear`, then only:

- `PATH` set to a fixed list: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
- `HOME` and `USER` and `LOGNAME` for the invoking user (askpass runs as that user; sudo will set the command's `HOME` to root's via `env_reset`)
- `LANG` and `LC_ALL` only if they were `C` or `C.UTF-8` or a simple `ll_CC.UTF-8` tag with no newline
- `TERM=dumb`
- `SUDO_ASKPASS` set to this binary, plus `HARNESS_ASKPASS=1` and `HARNESS_ASKPASS_SOCK` for the askpass child only. Those two are added after the `HARNESS_*` strip. They are not in the list the root command is meant to see; sudo's `env_reset` drops them. The real-sudo environment test asserts no `HARNESS_` name is in the command's `/proc/self/environ`.

Explicitly removed even if someone later adds them to a keep-list by mistake: `XAI_API_KEY`, `HARNESS_DB_KEY`, `HARNESS_HANDOFF_FD`, `HARNESS_TOKEN`, `HARNESS_KEYS_FILE`, `HARNESS_DB_PATH`, `HARNESS_ALLOWED_HOSTS`, and every variable whose name starts with `HARNESS_`. The launch token is not an environment variable today (it lives in the process). It is stripped anyway if it is present. The password is not a variable.

No `-E`, no `--preserve-env`, no `--preserve-env=NAME`. Observed: `-E` copied an API-key probe into the root process, and a normal `env_reset` still forwarded `PS1`. Clearing the environment before exec is what makes `env_keep` in sudoers harmless, because sudo cannot keep a variable the parent did not pass.

The root command's stdin is `/dev/null`. Its stdout and stderr are the capture pipes.

The program is the canonical path of `/usr/bin/sudo`, resolved at startup, not a `PATH` lookup. A `sudo` in the workspace must not win. The device and inode are remembered, the same idea as a custom tool's executable stamp. If `/usr/bin/sudo` is replaced during the launch, the tool refuses and does not run.

Working directory is the launch directory (`WORKSPACE_DIR`), not sudo's default and not whatever the harness's current directory has become. `sudo -D` / `--chdir` is not used. On this sudoers policy it is refused even for `NOPASSWD: ALL` (`you are not permitted to use the -D option`). Relying on it would make the tool fail closed on a stock policy, or tempt a sudoers edit the owner should not have to make.

The command is one argv element, as in `run_cmd`. It is not concatenated into a shell string. The argv after `--` is:

```
<harness> --sudo-supervisor --
  /bin/sh -c <fixed script> _ <workspace> <command>
```

The fixed script is:

```
cd -- "$1" || exit 127
shift
exec /bin/sh -c "$1"
```

`_ ` is `$0`. `$1` is the canonical workspace path. After `shift`, `$1` is the approved command. Spaces, quotes, and newlines in either value stay inside that argument. The inner shell is what interprets the command, which is the same contract as `bash -c` for `run_cmd`. `exec` replaces the outer script so the command's shell is a direct child of namespace pid 1.

If the directory cannot be entered, the shell exits 127 and the output review shows that. The command has not run.

### argv versus a shell

`sudo -- id` with a split argv would avoid a shell. The model does not send an argv; it sends a command string, and the approval dialog shows that string. Matching `run_cmd` means a shell. The shell is below sudo and below the supervisor, and the command is a single argument, so the harness is not the thing doing quote interpolation. A second shell wrapper that builds `cd <dir> && <command>` by pasting text is forbidden. That is the injection bug this argv layout exists to avoid.

The dialog shows the command the shell will interpret, with the same `safeDisplay` treatment as `run_cmd` (newlines visible, bidi controls escaped). It also shows the fixed fact that this will run as root, in the launch directory, with stdin closed. It does not show the supervisor's script as if the model had typed it. History records both the approved command and `auth: "password"` or `auth: "nopasswd"`.

### Rejected alternatives

- **`sudo -D` / `--chdir` first, `cd` as a fallback.** Rejected as the primary path because the policy on a normal sudoers `ALL` rule denied `-D`. Probing `-D` on every call adds a second sudo invocation and a second failure mode. The `cd` script works whether or not the policy allows `-D`.
- **Trusting `env_reset` alone.** Rejected because `env_keep` and `SETENV` are sudoers choices, and `-E` was enough to leak a probe key. The parent environment is the one the harness controls.
- **Passing the harness environment minus three names.** Rejected. `capture.rs` only removes `XAI_API_KEY`, `HARNESS_DB_KEY`, and `HARNESS_HANDOFF_FD`. That is the right bar for an ordinary shell that is not root. Root plus an `env_keep` of `PS1` is already a reminder that "remove the names we remember" misses the next name.
- **A login shell (`sudo -i`).** Rejected. It reads root's startup files and changes the directory to root's home, which fights the launch-directory rule and runs more code than the person approved.

## 5. Everything else that has to be decided

### Command injection and quoting

The model command is one argument. The workspace path is another. The script does not expand either of them. A command of `echo $(id)` is the model's command, shown in the dialog, and it does run `id` if the person accepts it, because that is what the shell command means. The harness must not add its own expansion on top.

NUL bytes cannot appear in a Rust string. A workspace path that contained a newline would already have been refused by the workspace setting; the supervisor still refuses a path containing NUL or newline rather than passing it.

`run_cmd` blocks a command that invokes `sudo`, `su`, `pkexec`, or `doas`. The check is a token scan, not a substring. The command does not run. The dialog and the tool result say to use `run_sudo_cmd`.

The scan treats these as still in command position: leading whitespace, `env` and its flags, absolute paths such as `/usr/bin/sudo`, chains with `&&`, `;`, and `|`, subshells including `$(sudo …)` and backticks, leading redirects (`>/tmp/x sudo`, `</dev/null sudo`, `2>x sudo`), and assignments that are prefixes of a simple command (`FOO=bar sudo`). A literal assignment `a=sudo` or `a=/usr/bin/sudo` is remembered, and `$a` in command position matches; a later assignment replaces it. `exec`, `eval`, and `setsid` are prefixes. `command -p`, `stdbuf -oL`, and `flock` are wrappers: their option words are skipped and the following command is scanned. `eval`'s next word is scanned again. `$'...'` is decoded, including `\xHH`, so `$'sudo'` and `$'\x73udo'` match. `sh`, `bash`, `zsh`, and `dash` (including a path ending in those names) with `-c` or a short option cluster that contains `c` (for example `-lc`) have that argument scanned recursively, up to four levels. `python`, `python3`, `perl`, `ruby`, and `node` with `-c` are scanned for an elevation word anywhere in that string. `$(echo sudo)` matches because a command substitution is scanned in a mode that flags an elevation word even when it is not in command position. `--sudo-reaper` and `--sudo-supervisor` match anywhere in the command.

This is a speed bump, not a guarantee. The scan does not catch, and is not going to catch by getting cleverer about strings:

- Indirection through a value that is not itself an elevation word: `a=$(printf '\x73udo'); $a`, or `b=$a` when `a` was not assigned a literal `sudo` in this command.
- A script file or a binary that then execs sudo. The scanner does not read that file.
- An interpreter invocation that does not use `-c`, such as `python3 exploit.py`.

The block is not a general deny-list. The dialog still shows the command.

### sudo's own log

sudo writes an auth log line (journal or `/var/log/auth.log`) with the invoking user and the command. That line will include the supervisor path and the approved command. It will not include the password or the command's output. This is an audit record, not a leak to the model. The design does not set `syslog=off` and does not ask the owner to. Do not put secrets in the command text; the log keeps that text. The history event is the harness's copy of the same fact, without the output unless they kept it.

### Prompt injection

Fetched pages, PDFs, and corpus chunks are already untrusted in the system prompt: only the per-launch comment marker is the person speaking. `run_sudo_cmd` reuses `provenance_notes` on the command string. A verbatim match gets the same warning as `run_cmd`, plus one root-specific sentence: accepting runs it as root. The warning stays advisory.

The tool being off until the checkbox is turned on is the other half. A page that tells the model "call `run_sudo_cmd`" does nothing while the tool is not in the list sent to the model. Turning the checkbox on still does not approve a call.

### Enable toggle

`run_sudo_cmd` is a built-in, listed with the others, and omitted from `default_enabled()`. The existing tool checkbox is the toggle. Off at process start. On only after the person checks it. A restart clears it, because the set lives in process memory, not in `localStorage` and not in the repo. The checkbox subtitle says it runs commands as root and that checking it does not approve any call.

While it is off, it is absent from `current_tools`, so the model is not invited to call it. A forged call with the tool missing is handled like any unknown tool.

No extra numeric rate limit. The process already caps state-changing requests (240 per minute). A root call also waits on a dialog with no auto-approve. A silent "three sudos per run" counter would block a real install sequence without asking. The checkbox and the dialog are the brakes.

### Visual styling

The call dialog and the output dialog get a class on the existing modal, in `web/style.css`, not a new page. A strong left border (amber against the current blue tool edge) and a title `Root command (round N)`. The cloud banner uses the existing cloud color at full strength, larger than the quiet `.cloud-label`, and sits directly above the command or the review box. The password field uses the modal's existing input styling. No new font, no new document, no framework.

`ask_user`, web, PDF, and ordinary `run_cmd` keep their current look.

### Timeout

`run_cmd` defaults to no time limit. Root defaults to **30 seconds**. The model may pass `30s`, `20m`, or `none`, using the same parser as `run_cmd`. An omitted or empty timeout becomes `30s`, not `none`. The dialog shows the choice and lets the person switch this call to 30 seconds, 20 minutes, or no limit before Accept, same control as `run_cmd`. `none` is a deliberate selection, not the thing that happens when the model forgets the field.

Stop still ends a `none` command. The dialog says that, as it does for `run_cmd`.

Unrecognized values do not spawn, same as `run_cmd`.

### Audit trail

For each call, history gets the usual sequence, and nothing with the password in it:

- `tool_call`: name, command, task, timeout, round.
- `approval`: decision, whether the person edited the command, provenance notes, `auth` = `password` or `nopasswd`, `timestamp` = `reset` (because `-k` is always on). Not the password, not the socket name.
- `tool_preview`: raw capture, or the withheld sentence, plus duration and exit code when the OS reported one. Written after the review decision, or at abort if they never decided.
- `tool_result`: the submitted text or the interrupt.

sudo's auth log is the system copy of the command. The survivor line, if a root pid outlives Stop, is part of the preview so it cannot vanish into a log the person does not open.

### Root can read the harness

`harden.rs` already states the limit: non-dumpable stops a same-user shell from reading `/proc/<pid>/environ`, `/proc/<pid>/mem`, and from `ptrace`. It does not stop root. A root command can print `XAI_API_KEY` or the history passphrase out of this process. The mitigations are the ones this design can actually enforce: the person sees the command first, the output does not reach the model until they submit it, and they can withhold it from history. The tool description tells the model not to read harness secrets. That sentence is not a barrier. The dialog is.

### Files a later implementation touches

No new HTML document. The page is still `web/index.html` plus the scripts `config.rs` already concatenates.

- `src/tools/run_sudo.rs` — schema, probe, spawn, review handoff. New.
- `src/sudo_supervisor.rs` — early `--sudo-reaper`, `--sudo-supervisor`, and the askpass environment dispatch. New.
- `src/tools/capture.rs` — a kill sequence the sudo path can select. Do not change the ordinary `SIGKILL` group behavior for `run_cmd`.
- `src/stream.rs` — the two dialogs, never `skip_output_review` for this name, delay the preview record.
- `src/tools/mod.rs` — register the tool, omit it from the default enable set, strip it from both allow-sets.
- `src/server.rs` — accept a password field and keep it out of `record_approval`.
- `src/model_voice.rs` — the description the model reads.
- `web/js/approval.js`, `web/index.html`, `web/style.css`, `web/js/tabs.js` — dialog, banner, password field, keep checkbox, tool row.
- `Cargo.toml` — `zeroize`.

`README.md` gets a short pointer in the implementation's last phase, not in this change.

## Threat model

The attacker in scope is a model that wants a root command or wants root output in its context, a web page the model just fetched, and another local process that does not have the launch token. The person at the keyboard is the operator, not the adversary. A person who types their password into a command they did not read is outside what software can stop; the dialog's job is to make that reading possible.

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Model sends root output, or a secret the command printed, straight into the next prompt | Output review cannot be skipped by the `run_cmd` switch or by Allow all. Only the submitted text is appended | The person submits it, or later presses Generate on a continue draft that still contains it. A cloud model then receives that text |
| Cloud model receives root output that never needed to leave the machine | Loud cloud banner on both dialogs. Local banner when the model is local | They submit anyway. HTML export and a kept preview also leave the machine if they copy those files |
| Password captured by the command (`cat`, a logger on stdin) | Stdin closed. Never `-S`. Askpass only when `sudo -n true` fails. NOPASSWD path never writes the password anywhere | A command that reads the helper's memory or sudo's memory while the password is in flight. The window is the askpass call, and the helper is non-dumpable before it reads the password |
| Password in `/proc` cmdline or environ, in history, or in the model | Socket name is in sudo's environment, not argv, and the reaper drops it before it waits. Password is sent only after the peer check. The helper is non-dumpable before it connects. Request body and the serde `String` are volatile-zeroed. Approval record stores `auth` only | The socket name is in sudo's environment, which a same-uid process cannot read once sudo is non-dumpable. The JavaScript string that built the POST cannot be wiped. A shared `Bytes` buffer that cannot be made unique is not wiped |
| Another local process drives `/approve` and supplies a password | Existing launch token and same-origin checks. Password is not useful without a pending approval id | Anyone who has the token is already the operator of this launch. The token in the URL is still a bearer token; that is unchanged |
| Cached sudo ticket turns the next call, or a terminal sudo, into a silent root shell | `-k` on the command: ignore the cache, do not refresh it | A sudoers `NOPASSWD` rule still authorizes with no ticket and no password. The dialog says that |
| Stop or timeout leaves a root child | Non-setuid reaper with `SIGTERM` parent-death, then the pid-namespace supervisor. `SIGTERM` the reaper; it `SIGKILL`s sudo's group. sudo itself has `PR_SET_PDEATHSIG=SIGKILL` armed by the supervisor, so `SIGKILL` or `SIGSTOP` then `SIGKILL` of the reaper still kills sudo. Survivor pids are reported | A command that leaves the namespace by some path other than the dropped capabilities, after the person accepted it. The arming uses `ptrace` and is implemented on x86_64; if it fails the command is not run |
| `use_pty` puts the command in a session `killpg` does not reach | The kill path does not depend on the process group. The namespace dies with pid 1 | sudo versions older than the relay behavior in 1.9 still die via the parent-death signal when sudo itself is `SIGKILL`ed. The test plan covers the version in use |
| Harness secrets inherited by root | `env_clear` and an allowlist. No `-E`. Stamp on `/usr/bin/sudo` | Root can read the harness process anyway. Review is the gate. A sudoers plugin that injects env from outside the process is a host compromise, not something this tool can see |
| Command injected by quote pasting | Command and directory are separate argv elements to a fixed script | The command is still a shell command. `echo $(id)` does what it says if accepted |
| `run_cmd` used to dodge the root tool | `sudo`, `su`, `pkexec`, and `doas` are blocked as command words, including after redirects, wrappers (`exec`, `setsid`, `flock`, `stdbuf`, `command -p`), literal `a=sudo` expansions, ANSI-C quotes, `sh -c`, `python3 -c`, and `$(echo sudo)`. The message says to use `run_sudo_cmd` | A speed bump. Not caught: an assigned value that is not itself the word, a script file, or `python3 exploit.py`. The dialog still shows the text |
| Root command writes host configuration | A fresh procfs replaces every proc mount in the command's mount namespace, and `/proc/sys` on that procfs is read-only. Failure refuses the command | `/sys` is not locked. Root can still write `/sys` and can still do other root things. This tool is not a sandbox |
| Page tells the model to call sudo | Tool off by default. Provenance warning on a verbatim match. System prompt already treats tool results as data | The person turns the tool on and accepts the command. The warning can miss a paraphrased command |
| sudo auth log or journal keeps the command | Accepted. The log is local audit. Password and output are not part of that line | The command text itself is sensitive if they put a secret in the command. The dialog is the place they would see that |
| HTML archive or `localStorage` keeps root output they thought they had declined | Preview is not written or persisted until the decision. Withhold stores a fixed sentence. HTML header names root output when a kept preview is present | Stop before the decision stores the raw preview. A kept checkbox stores it on purpose |
| Replaced `/usr/bin/sudo` or a workspace `sudo` on `PATH` | Canonical `/usr/bin/sudo`, inode stamp, no `PATH` search | Replacement before startup is a compromised host. The stamp catches replacement during the launch |
| Askpass helper swapped for something that steals the password | `SUDO_ASKPASS` is this binary. There is no script to rewrite. The helper locks itself before any socket call. The server sends the password only to a non-dumpable, untraced peer whose direct parent is this sudo and whose stdout fifo sudo is holding | The instructions between `exec` and the first `prctl` can still be raced by a same-uid tracer. After the lock, `ptrace` returns `EPERM`, and a traced peer is refused |

## Test plan

A later implementation is not done until these pass. Tests that need a real root sudo are skipped with a clear message when `sudo -n true` is not permitted, and the fake-sudo tests still run. The kill and stdin tests are not optional on a machine where `sudo -n true` works; that is the environment that can show the bug.

### Required

1. **Password never appears in tool output, including NOPASSWD `cat`.** Drive a capture whose stdin is closed. Queue a known password as if it had been typed. Run the equivalent of `cat` and of `cat /proc/self/fd/0` under `sudo -n`. Assert the password is absent from stdout, stderr, the timeout note, the spawn error, the history approval payload, the preview, and the tool result. A second case uses a fake sudo that prints its stdin and its argv: stdin is empty and argv does not contain the password. Assert the askpass helper's `/proc/<pid>/cmdline` and `environ`, sampled from a helper that pauses, do not contain the password.
2. **Stop and timeout kill the root child.** With the supervisor: `sleep 30` in the background, a foreground `sleep 30`, and `setsid sleep 30`, under one shell. Stop the capture. Every pid recorded from the tree is gone, without the test itself calling `sudo kill`. Repeat with a 300 ms timeout. Repeat in a loop that Stops immediately after spawn. Fail if the survivor sentence is produced or if a root `sleep` remains.
3. **No harness secrets in the root environment.** The env builder's map contains none of `XAI_API_KEY`, `HARNESS_DB_KEY`, `HARNESS_HANDOFF_FD`, `HARNESS_TOKEN`, any other `HARNESS_*` name, or the password. Argv does not contain `-E` or `--preserve-env`. A fake sudo prints the environment it received and the test asserts the same. Where `sudo -n true` works, a real `sudo -n` command prints `/proc/self/environ` and the test asserts those names and a planted parent value are absent.
4. **Output review cannot be bypassed.** With `review_run_cmd` false, with the name posted in `approve_calls`, and with it posted in `approve_outputs`, `set_tool_policy` does not store the name in either set. A run that executes the tool still emits a second approval whose payload is the capture, and does not append that capture to the model messages unless the decision is a submitted string. `automatic_submitted_output` is not on this path. An empty capture still produces the second dialog rather than a model message.

### Also required before the tool is registered by default

- Default enable set does not contain `run_sudo_cmd`. After a fresh `AppState`, `current_tools` omits it. Enabling it through the policy API includes it. Restarting the set (a new state) omits it again.
- `sudo -b` is absent from argv. The program path is the canonical sudo, not `sudo` looked up on `PATH`.
- Command `echo hi > /tmp/x` and a workspace path containing a space and a single quote both round-trip as single argv elements. The script source in the argv does not contain the command or the path as pasted text.
- `sudo -D` is absent from argv.
- NOPASSWD probe: when `sudo -n true` exits 0, the approval payload says `auth: nopasswd` and the password buffer is empty before spawn. When the probe fails because a password is required, spawn is not attempted without a password having been provided to askpass (fake sudo that exits 1 with the password-required text is enough where the real policy is NOPASSWD).
- Withhold: after a review decision with keep unchecked, the history preview is the fixed sentence and the tool result is the edited text. With keep checked, the preview is the raw capture. An aborted wait stores the raw preview and does not produce a model message.
- Provenance: a command that appears verbatim in a fetched artifact produces the note on the call dialog.
- `run_cmd` block: a command that invokes `sudo`, `su`, `pkexec`, or `doas` as a command word does not run and tells the model to use `run_sudo_cmd`. A command that only mentions those names as arguments does not, except `--sudo-reaper` and `--sudo-supervisor`, which match anywhere. Leading redirects, `exec`/`eval`/`setsid`, `flock`, `stdbuf`, `command -p`, `$'...'`, `sh -c`, literal `a=sudo` expansions, `python3 -c`, and `$(echo sudo)` are caught. `a=$(printf '\x73udo'); $a` and a script file are not. The check is a speed bump, not a guarantee.
- Askpass rewrite: a fake sudo that sleeps, then runs the helper with stdout pointed at a regular file, does not receive the canary in that file. There is no script for it to rewrite.
- Askpass ptrace: once the helper has connected, `PTRACE_ATTACH` returns `EPERM`. The helper locked itself before the connect.
- Harness `SIGKILL`: a child that has started root `sleep` processes, including `setsid sleep`, is `SIGKILL`ed. Those sleeps are gone without the test calling `sudo kill`.
- `/proc/sys`: a root command that writes `/proc/sys/kernel/core_pattern`, `/proc/<pid>/root/proc/sys/kernel/core_pattern`, or a newly mounted procfs does not change the host file.
- Privilege drop fails closed: `drop_supervisor_privileges` returns an error when the caller cannot drop the bounding set (a non-root child has no `CAP_SETPCAP`).
- The `/approve` body buffer is zero after the password field is taken. A shared `Bytes` that `try_into_mut` refuses is the residual copy.
- Timeout: omitted timeout is 30 seconds. `none` and `20m` are honored when the dialog selects them. `turbo` does not spawn.
- Zeroize: after the helper finishes, the server buffer's bytes are zero. This can be a unit test of the wrapper that drops the `Zeroizing` value and checks a canary slot the test owns, without printing the canary on failure.
- Inode stamp: replacing the remembered sudo path's target (a copy in a temp directory used as the resolved sudo) refuses the call.
- Capabilities: after the namespace exists, the supervisor's effective set is empty and `no_new_privs` is set. The command's bounding set does not include `CAP_SYS_ADMIN` or `CAP_SYS_PTRACE`.
- Non-Linux build of the supervisor path returns a clear error and does not spawn. The rest of the harness still builds.

The ordinary `capture.rs` tests stay as they are. A `run_cmd` of `sleep` is still killed by group `SIGKILL`. This tool does not change that.

## Phased implementation

Each phase is a reviewable change. Later phases do not start by registering the tool with the model.

1. **Supervisor and kill path.** Early argv modes. Pid namespace, parent-death signal, the `TERM`-then-`KILL` sequence, survivor text. Tests for Stop, timeout, and `setsid`, using `sudo -n` when it is allowed and a fake sudo that execs the supervisor as the user only for the argv tests (the namespace test needs real sudo). No HTTP, no tool schema.
2. **Environment, stdin, quoting, sudo stamp.** `env_clear` allowlist, closed stdin, fixed `cd` script, canonical sudo. The password-not-in-`cat` test and the secret-environment test. Still no model-facing tool.
3. **Askpass and the password buffer.** Abstract socket, peer check (direct parent, `/proc/<pid>/exe` inode, stdout fifo), `zeroize` of the request body, NOPASSWD probe, `-k -A`. `SUDO_ASKPASS` is this binary. Tests that the password is absent from cmdline, environ, and captured output. Fake sudo that execs `SUDO_ASKPASS` and prints what it read on the pipe, so the peer check is tested without a password prompt.
4. **Tool loop.** Schema in `model_voice`, registration, default off, strip from both allow-sets, both dialogs, delayed preview, withhold sentence, provenance, and the `run_cmd` block for `sudo`, `su`, `pkexec`, and `doas`. Loop tests for "review cannot be skipped" with the switches set against it. The tool is callable only when enabled.
5. **Page.** One document: password field, root class, loud cloud banner, local banner, keep checkbox, tool checkbox subtitle, timeout default displayed as 30 seconds. Browser tests in the existing `web/js` node tests for "provisional preview is not persisted" and "Allow all menus are not offered for this name".
6. **README pointer.** A short section that links this document and states the operator-visible rules: off until enabled, password only when sudo asks, output review always, Stop kills the root child. No second copy of the threat model.

Phase 1 and 2 are the ones that are unsafe to skip. A tool that reviews output carefully and then orphans a root process on Stop is not shippable.

## Open questions

These were open when the design was written. The implementation follows the answers below.

1. **Default timeout is 30 seconds, not "no limit".** Kept. `run_cmd` stays unlimited when the field is omitted. Root does not.
2. **Keep-the-capture starts unchecked.** Changed. The raw root output is stored only when the reviewer checks the box. HTML export follows what was kept. Stop before a choice still stores the raw preview, because they did not get to withhold it.
3. **`-k` on every call, and no extra `sudo -K`.** Kept. This call re-authenticates when a password is required and does not refresh a ticket. It does not clear tickets in other terminals.
4. **`sudo` inside `run_cmd` is blocked.** Changed. A token check refuses `sudo`, `su`, `pkexec`, and `doas` as command words, including after whitespace, `env`, an absolute path, `&&` / `;` / `|`, subshells, leading redirects, `exec`/`eval`/`setsid`, `flock`, `stdbuf`, `command -p`, literal `name=sudo` expansions, ANSI-C quotes, `sh -c`, `python3 -c`, and `$(echo sudo)`. The message tells the model to use `run_sudo_cmd`. This is a speed bump, not a guarantee. Still missed: a value that is not a literal elevation word, a script file, and an interpreter that does not pass `-c`.
5. **Root can read harness memory.** Accepted residual risk. Non-dumpable does not stop uid 0. The review gate is the mitigation. The command cannot hold `CAP_SYS_PTRACE` after the capability drop, which closes one path; a root read of this process through another interface is still possible. The askpass helper is non-dumpable before it reads the password, which does stop a same-uid `ptrace`.
6. **sudo's auth log will contain the approved command.** Accepted. Output and password are not in that line. The implementation does not turn syslog off.
7. **Namespace escape.** The supervisor drops `CAP_SYS_ADMIN` and `CAP_SYS_PTRACE`, and every other capability it does not need, as soon as the pid namespace exists. A failed drop aborts the command. The command drops those two as well and cannot regain them. `no_new_privs` is set on the supervisor processes. It is not set on the command, because that would strip the remaining root capabilities on exec. A command that still escapes by some other means was accepted in the dialog.
8. **`/proc/sys` is read-only for the command, on a fresh procfs. `/sys` is not.** Pid 1 mounts a new procfs over every proc mount in its private mount namespace, then remounts `/proc/sys` read-only. Host pids are not listed, so `/proc/<host pid>/root/...` is not a way back to the host proc. `/sys` stays as the host left it. Root can still write `/sys` and can still do other root things. This tool is not a sandbox.
9. **Parent death uses a reaper, and sudo is armed after exec.** `PR_SET_PDEATHSIG=SIGKILL` does not survive sudo's setuid exec, so the harness spawns a non-setuid reaper whose parent-death signal is `SIGTERM`. The reaper's handler `SIGKILL`s sudo when it is allowed to run. The supervisor also sets `SIGKILL` as sudo's parent-death signal, with `ptrace`, so a `SIGKILL` of the reaper — including after `SIGSTOP` — kills sudo without that handler. The child still sets `SIGKILL` immediately before exec of sudo, for the window before the image is replaced. A user-namespace pid namespace was tried and does not nest under host root (`unshare(CLONE_NEWPID)` returns `EINVAL`).
