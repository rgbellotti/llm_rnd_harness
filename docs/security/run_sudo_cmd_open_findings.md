# Findings for `run_sudo_cmd`

> **Note:** the askpass implementation these findings reviewed has been
> removed from the tree (`run_sudo_cmd_relay` replaced the tool outright).
> This record stays for the design review history; the mechanisms it
> describes (reaper, supervisor, askpass hardening) exist only in git history
> and [docs/design/run_sudo_cmd.md](../design/run_sudo_cmd.md).

These are the items from the independent re-review of commit `7ffd06b`. The review page is https://cursor.com/canvas/store-3d8a26ec-869c-4a4b-8df1-1e5244c7e253/6fd7acc7-3749-434b-83d5-1924d7f86e13.

That review's verdict on the previous round still stands: High 1, High 3 for harness death, and Low 6, 7, and 8 were fixed in `7ffd06b`. High 2 was partial. Medium 4 was still open. This note records what happened to the six items that were deferred at the merge.

## 1. Same-uid kill of the reaper leaves the root tree

**Severity:** High

**Status:** Resolved.

**What changed:** A non-setuid pid namespace between the reaper and sudo cannot hold host-root sudo. An unprivileged user namespace can create a pid namespace, and host root can `setns` into it, but `unshare(CLONE_NEWPID)` from that host-root process returns `EINVAL` because the pid namespace belongs to the other user namespace. The supervisor instead stops each sudo process between itself and the reaper, runs `prctl(PR_SET_PDEATHSIG, SIGKILL)` with `ptrace`, and restores the registers. sudo is the reaper's direct child, so the reaper's death delivers `SIGKILL` to sudo even when the reaper's handler does not run. A `SIGSTOP`'d reaper is the same case: the harness's later `SIGKILL` still kills sudo. If the arming fails, the command is not run. This is implemented on x86_64.

**Test:** `sigkill_or_sigstop_of_the_reaper_kills_the_root_tree`. One pass `SIGKILL`s the reaper. The other `SIGSTOP`s it, sends `SIGTERM`, then `SIGKILL`s it. Root `sleep` and `setsid sleep` are gone. `sigkill_of_the_spawning_parent_kills_the_root_tree` still covers harness death.

## 2. Host `core_pattern` via the supervisor's `/proc` root

**Severity:** Medium

**Status:** Resolved for the host-proc class. `/sys` remains the documented residual.

**What changed:** Pid 1, in its private mount namespace, mounts a fresh procfs over every proc mount. That procfs lists only pids in the namespace, so `/proc/<host pid>/root/proc/sys` is not a path to the host proc. `/proc/sys` on the new procfs is then bind-mounted read-only, because a new procfs still exposes the global sysctls. A new `mount -t proc` from the command needs `CAP_SYS_ADMIN`, which the command has dropped. Failure of the mount setup refuses the command.

**Test:** `root_command_cannot_write_proc_sys_core_pattern`. The command writes `/proc/sys/kernel/core_pattern`, every `/proc/<pid>/root/proc/sys/kernel/core_pattern`, and a procfs it tries to mount itself. The host file is unchanged and the command reports no successful write.

## 3. Pre-handshake ptrace of the askpass helper

**Severity:** Low

**Status:** Minimized. The exec-to-`prctl` window is still open.

**What changed:** The helper's first action, before any socket call, is `PR_SET_DUMPABLE` 0, `PR_SET_NO_NEW_PRIVS`, `RLIMIT_CORE` 0, and `PR_SET_PTRACER` 0 when Yama is present. It refuses to continue if it is traced. It sends the device and inode of its stdout. The server sends the password only when `/proc/<peer>/exe` is unreadable (the helper has locked itself), `TracerPid` is 0, the direct parent is sudo, and that inode is a fifo sudo holds. The helper checks the inode and `TracerPid` again immediately before writing the password. A still-readable exe is rejected, so a tracer cannot satisfy the old `EACCES` wait by setting dumpable on a helper that has not locked itself.

**Test:** `askpass_helper_cannot_be_ptraced`. After the helper connects, `PTRACE_ATTACH` returns `EPERM`. `rewritten_askpass_stdout_does_not_receive_the_password` still checks a stdout redirect. `fake_sudo_askpass_delivers_the_password_only_to_the_helper` still checks that the real pipe receives the password.

**Residual:** The instructions between `exec` and the first `prctl` can still be raced by a same-uid tracer. After the lock, attach fails and a traced peer is refused.

## 4. Askpass socket name in the reaper environment

**Severity:** Low

**Status:** Resolved for the reaper. sudo still has the name, because the askpass child inherits sudo's environment.

**What changed:** After the reaper forks the process that execs sudo, the reaper removes `HARNESS_ASKPASS`, `HARNESS_ASKPASS_SOCK`, and `SUDO_ASKPASS` and sets itself non-dumpable. The child keeps the variables. The root command does not receive them.

**Test:** `reaper_environ_does_not_expose_the_askpass_socket`. The sudo child's environment contains the marker. The reaper's `/proc/<pid>/environ` is either unreadable or does not contain it. `real_sudo_environment_has_no_harness_secrets` still checks the root command.

## 5. Elevation scanner misses

**Severity:** Low

**Status:** The documented spellings are caught. The check is still a speed bump.

**What changed:** Literal `a=sudo` and `a=/usr/bin/sudo` are remembered and `$a` in command position matches. `setsid`, `flock`, `stdbuf`, and `command -p` are wrappers. `$(echo sudo)` is scanned even though `sudo` is not in command position. `python3 -c` (and `python`, `perl`, `ruby`, `node`) is scanned for an elevation word anywhere in the `-c` string. `--sudo-reaper` and `--sudo-supervisor` match anywhere, which covers `llm_rnd_harness --sudo-reaper -- /usr/bin/sudo`.

**Test:** `elevation_tokens_cover_paths_env_and_chains`.

**Still open, on purpose:** `a=$(printf '\x73udo'); $a`, `b=$a` when `a` was not assigned a literal elevation word in this command, a script file, and `python3 exploit.py`. The dialog still shows the command.

## 6. JavaScript password string

**Severity:** Info

**Status:** Minimized. The string itself cannot be wiped.

**What changed:** The field is cleared before the value is copied. The object property is deleted immediately after `JSON.stringify`. The local that held the JSON is set to an empty string after the request returns, including on failure. The body is not logged and is not stored on the session.

**Residual:** JavaScript cannot zero a string. The request body the browser keeps can remain until the engine collects it.
