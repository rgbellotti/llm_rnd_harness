//! Keep `XAI_API_KEY`, `REFLECTION_API_KEY`, and `HARNESS_DB_KEY` out of a
//! shell command's reach.
//!
//! `std::env::remove_var` drops a variable from the libc environment a child
//! inherits. It does not wipe the bytes `execve` placed on this process's
//! stack. Linux serves that block at `/proc/<pid>/environ`. A same-uid
//! process can also read `/proc/<pid>/mem` and `ptrace` a dumpable process,
//! which is the default. Yama's ptrace scope does not cover those reads.
//!
//! On Linux, startup does two things:
//!
//! 1. If either secret is in the block `/proc/self/environ` serves, re-exec
//!    this binary once without those variables. The values cross the exec in
//!    a pipe, then `set_var` puts them back for [`crate::keys::prepare`].
//!    `set_var` does not rewrite the stack block, so the new
//!    `/proc/<pid>/environ` does not contain them.
//! 2. Mark the process non-dumpable (`PR_SET_DUMPABLE` 0). A same-uid child
//!    then cannot open `/proc/<pid>/environ` or `/proc/<pid>/mem`, and
//!    `ptrace` fails. Tool processes inherit that flag. `/proc/<pid>/stat`
//!    stays readable, which is what the capture code uses to tell a live
//!    pid from a recycled one.
//!
//! Root, or a process with `CAP_SYS_PTRACE`, can still read the memory. The
//! secrets stay in this process because the harness uses them. The process
//! is dumpable for the short stretch before `main` reaches [`startup`]; the
//! re-exec'd process is non-dumpable from its first instruction.

/// Name of the file descriptor the re-exec'd process reads the secrets from.
/// The number is not a secret. The descriptor is closed before any tool runs.
pub(crate) const HANDOFF_FD_VAR: &str = "HARNESS_HANDOFF_FD";

const HANDOFF_MAGIC: &[u8] = b"HND1";
const HANDOFF_MAX_BYTES: usize = 64 * 1024;

/// Call once, before the runtime starts and before any tool process. The
/// secret list is the provider registry's: every provider API key plus
/// the history passphrase, from one source.
pub(crate) fn startup() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        linux_startup()
    }
    #[cfg(not(target_os = "linux"))]
    {
        println!("harness: /proc secret protection is only applied on Linux.");
        let _ = std::io::Write::flush(&mut std::io::stdout());
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn linux_startup() -> Result<(), String> {
    // Read the stack block before dropping dumpable. After PR_SET_DUMPABLE 0
    // this kernel returns EACCES even for the process's own /proc environ,
    // so a later read cannot decide whether a re-exec is still required.
    match read_initial_environ() {
        Ok(initial) => {
            let present = secrets_in_environ(&initial);
            if !present.is_empty() {
                set_non_dumpable()?;
                reexec(&present)?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            // The re-exec'd image inherited non-dumpable. Its stack block is
            // already unreadable, and the secrets are not in it.
        }
        Err(error) => {
            return Err(format!(
                "harness: could not read /proc/{}/environ: {error}",
                std::process::id()
            ));
        }
    }
    set_non_dumpable()?;
    if let Some(fd) = take_handoff_fd()? {
        restore_handoff(fd)?;
    }
    println!("llm rnd - research and diagnostics harness");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_initial_environ() -> std::io::Result<Vec<u8>> {
    // `/proc/self` from a non-leader thread is that thread's task directory.
    // The process id is the thread-group leader, which owns the environ block.
    std::fs::read(format!("/proc/{}/environ", std::process::id()))
}

#[cfg(target_os = "linux")]
fn set_non_dumpable() -> Result<(), String> {
    set_dumpable_flag(0)
}

#[cfg(target_os = "linux")]
fn set_dumpable_flag(value: libc::c_ulong) -> Result<(), String> {
    // SAFETY: prctl only changes this process's dumpable flag.
    let rc = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, value, 0, 0, 0) };
    if rc != 0 {
        return Err(format!(
            "harness: could not set the dumpable flag to {value}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn secrets_in_environ(environ: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut found = Vec::new();
    // One list with the provider registry: keys.rs parses these, and the
    // tool-child scrub removes them. A new provider's key cannot be
    // forgotten here.
    for name in crate::providers::secret_env_vars() {
        if let Some(value) = environ_value(environ, name.as_bytes()) {
            found.push((name.to_string(), value));
        }
    }
    found
}

/// `KEY=value` at the start of the block or immediately after a NUL.
#[cfg(target_os = "linux")]
fn environ_value(environ: &[u8], name: &[u8]) -> Option<Vec<u8>> {
    let mut rest = environ;
    loop {
        if let Some(value) = rest.strip_prefix(name)
            && value.first() == Some(&b'=')
        {
            let value = &value[1..];
            let end = value
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(value.len());
            return Some(value[..end].to_vec());
        }
        let index = rest.iter().position(|byte| *byte == 0)?;
        rest = &rest[index + 1..];
    }
}

#[cfg(target_os = "linux")]
fn reexec(secrets: &[(String, Vec<u8>)]) -> Result<(), String> {
    let listed = secrets
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(" and ");
    let verb = if secrets.len() == 1 { "was" } else { "were" };
    let pronoun = if secrets.len() == 1 { "it" } else { "them" };
    let value_word = if secrets.len() == 1 {
        "value"
    } else {
        "values"
    };
    println!(
        "harness: {listed} {verb} in the starting environment. Re-executing this process without {pronoun} so /proc/<pid>/environ does not keep the {value_word}."
    );
    let _ = std::io::Write::flush(&mut std::io::stdout());

    let mut fds = [0i32; 2];
    // SAFETY: pipe writes two new descriptors into `fds`. No other threads yet.
    let rc = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if rc != 0 {
        return Err(format!(
            "harness: could not create the secret handoff pipe: {}",
            std::io::Error::last_os_error()
        ));
    }
    let read_fd = fds[0];
    let write_fd = fds[1];
    let mut payload = encode_handoff(secrets)?;
    let wrote = write_all_fd(write_fd, &payload);
    zero_bytes(&mut payload);
    // SAFETY: `write_fd` came from pipe and is still open.
    unsafe { libc::close(write_fd) };
    wrote?;

    let exe = std::env::current_exe()
        .map_err(|error| format!("harness: could not find this executable to re-exec: {error}"))?;
    use std::os::unix::ffi::OsStrExt;
    let exe_c = cstring_bytes(exe.as_os_str().as_bytes()).map_err(|_| {
        "harness: the executable path contains a NUL byte. Refusing to re-exec.".to_string()
    })?;
    let mut args = Vec::new();
    for arg in std::env::args_os() {
        args.push(cstring_bytes(arg.as_bytes()).map_err(|_| {
            "harness: an argument contains a NUL byte. Refusing to re-exec.".to_string()
        })?);
    }
    if args.is_empty() {
        return Err("harness: this process has no argv. Refusing to re-exec.".into());
    }
    let mut env_items = Vec::new();
    for (key, value) in std::env::vars_os() {
        let is_secret = key
            .to_str()
            .is_some_and(crate::providers::is_secret_var);
        if is_secret || key == HANDOFF_FD_VAR {
            continue;
        }
        let mut pair = key.as_bytes().to_vec();
        pair.push(b'=');
        pair.extend_from_slice(value.as_bytes());
        env_items.push(cstring_bytes(&pair).map_err(|_| {
            "harness: an environment entry contains a NUL byte. Refusing to re-exec.".to_string()
        })?);
        zero_bytes(&mut pair);
    }
    let handoff = format!("{HANDOFF_FD_VAR}={read_fd}");
    env_items.push(cstring_bytes(handoff.as_bytes()).expect("handoff fd is a number"));

    let mut arg_ptrs: Vec<*const libc::c_char> = args.iter().map(|item| item.as_ptr()).collect();
    arg_ptrs.push(std::ptr::null());
    let mut env_ptrs: Vec<*const libc::c_char> =
        env_items.iter().map(|item| item.as_ptr()).collect();
    env_ptrs.push(std::ptr::null());

    // SAFETY: the path, argv, and envp are NUL-terminated C strings that
    // live until exec replaces this process. On success this call does not
    // return. The read end of the pipe stays open across the exec.
    let rc = unsafe { libc::execve(exe_c.as_ptr(), arg_ptrs.as_ptr(), env_ptrs.as_ptr()) };
    let error = std::io::Error::last_os_error();
    // SAFETY: exec failed, so the read end is still ours to close.
    unsafe { libc::close(read_fd) };
    let _ = rc;
    Err(format!(
        "harness: re-exec failed ({error}). This process was left non-dumpable, and the starting environment was not replaced."
    ))
}

#[cfg(target_os = "linux")]
fn take_handoff_fd() -> Result<Option<i32>, String> {
    let Some(raw) = std::env::var_os(HANDOFF_FD_VAR) else {
        return Ok(None);
    };
    // SAFETY: one variable, removed once, before any tool process.
    unsafe { std::env::remove_var(HANDOFF_FD_VAR) };
    let text = raw.to_string_lossy();
    let fd: i32 = text.parse().map_err(|_| {
        format!(
            "harness: {HANDOFF_FD_VAR} is {text:?}, not a file descriptor. Start the harness without that variable."
        )
    })?;
    if fd <= 2 {
        return Err(format!(
            "harness: {HANDOFF_FD_VAR} is {fd}, which is not the secret handoff. Start the harness without that variable."
        ));
    }
    Ok(Some(fd))
}

#[cfg(target_os = "linux")]
fn restore_handoff(fd: i32) -> Result<(), String> {
    // SAFETY: `fd` is the read end inherited across exec. CLOEXEC keeps a
    // later child from inheriting it if a spawn races the close below.
    unsafe {
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let mut payload = read_all_fd(fd)?;
    // SAFETY: `fd` is still the handoff read end.
    unsafe { libc::close(fd) };
    let secrets = decode_handoff(&payload);
    zero_bytes(&mut payload);
    let secrets = secrets?;
    for (name, mut value) in secrets {
        use std::os::unix::ffi::OsStringExt;
        let os = std::ffi::OsString::from_vec(value.clone());
        // SAFETY: startup, before other threads. Puts back the values the
        // re-exec removed, so keys::prepare can read them. This does not
        // rewrite /proc/<pid>/environ.
        unsafe { std::env::set_var(&name, &os) };
        zero_bytes(&mut value);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn encode_handoff(secrets: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    out.extend_from_slice(HANDOFF_MAGIC);
    for (name, value) in secrets {
        if !crate::providers::is_secret_var(name) {
            return Err(format!(
                "harness: refusing to hand off an unexpected variable ({name})."
            ));
        }
        push_counted(&mut out, name.as_bytes())?;
        push_counted(&mut out, value)?;
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    if out.len() > HANDOFF_MAX_BYTES {
        return Err("harness: the secret handoff is too large.".into());
    }
    Ok(out)
}

#[cfg(target_os = "linux")]
fn push_counted(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), String> {
    let len: u32 = bytes
        .len()
        .try_into()
        .map_err(|_| "harness: a secret is too large to hand off across re-exec.".to_string())?;
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

#[cfg(target_os = "linux")]
fn decode_handoff(mut payload: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if !payload.starts_with(HANDOFF_MAGIC) {
        return Err(
            "harness: the secret handoff was not written by this harness. Start it without HARNESS_HANDOFF_FD."
                .into(),
        );
    }
    payload = &payload[HANDOFF_MAGIC.len()..];
    let mut secrets = Vec::new();
    loop {
        let (name_len, rest) = take_u32(payload)?;
        payload = rest;
        if name_len == 0 {
            if !payload.is_empty() {
                return Err("harness: the secret handoff has trailing bytes.".into());
            }
            break;
        }
        let (name, rest) = take_bytes(payload, name_len as usize)?;
        payload = rest;
        let (value_len, rest) = take_u32(payload)?;
        payload = rest;
        let (value, rest) = take_bytes(payload, value_len as usize)?;
        payload = rest;
        let name = std::str::from_utf8(name).map_err(|_| {
            "harness: the secret handoff names a variable that is not text.".to_string()
        })?;
        if !crate::providers::is_secret_var(name) {
            return Err(format!(
                "harness: the secret handoff names {name}, which is not a harness secret."
            ));
        }
        secrets.push((name.to_string(), value.to_vec()));
    }
    Ok(secrets)
}

#[cfg(target_os = "linux")]
fn take_u32(bytes: &[u8]) -> Result<(u32, &[u8]), String> {
    if bytes.len() < 4 {
        return Err("harness: the secret handoff ended early.".into());
    }
    let len = u32::from_le_bytes(bytes[..4].try_into().expect("4 bytes"));
    Ok((len, &bytes[4..]))
}

#[cfg(target_os = "linux")]
fn take_bytes(bytes: &[u8], len: usize) -> Result<(&[u8], &[u8]), String> {
    if bytes.len() < len {
        return Err("harness: the secret handoff ended early.".into());
    }
    Ok((&bytes[..len], &bytes[len..]))
}

#[cfg(target_os = "linux")]
fn cstring_bytes(bytes: &[u8]) -> Result<std::ffi::CString, ()> {
    std::ffi::CString::new(bytes.to_vec()).map_err(|_| ())
}

#[cfg(target_os = "linux")]
fn write_all_fd(fd: i32, mut bytes: &[u8]) -> Result<(), String> {
    while !bytes.is_empty() {
        // SAFETY: `bytes` is a valid buffer and `fd` is the pipe write end.
        let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if n < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!(
                "harness: could not write the secret handoff: {error}"
            ));
        }
        if n == 0 {
            return Err("harness: could not write the secret handoff.".into());
        }
        bytes = &bytes[n as usize..];
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_all_fd(fd: i32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: `buf` is a valid buffer and `fd` is the pipe read end.
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!(
                "harness: could not read the secret handoff: {error}"
            ));
        }
        if n == 0 {
            break;
        }
        if out.len() + n as usize > HANDOFF_MAX_BYTES {
            return Err("harness: the secret handoff is too large.".into());
        }
        out.extend_from_slice(&buf[..n as usize]);
    }
    // The read buffer held secret bytes. Drop them before returning the copy.
    zero_bytes(&mut buf);
    Ok(out)
}

#[cfg(target_os = "linux")]
fn zero_bytes(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn assignment_scan_requires_the_name_at_a_boundary() {
        let buf = b"NOT_XAI_API_KEY=no\0XAI_API_KEY=yes\0REFLECTION_API_KEY=ref\0HARNESS_DB_KEY=db\0";
        assert_eq!(
            environ_value(buf, b"XAI_API_KEY").as_deref(),
            Some(b"yes".as_slice())
        );
        assert_eq!(
            environ_value(buf, b"HARNESS_DB_KEY").as_deref(),
            Some(b"db".as_slice())
        );
        assert_eq!(
            environ_value(buf, b"REFLECTION_API_KEY").as_deref(),
            Some(b"ref".as_slice())
        );
        assert!(environ_value(buf, b"API_KEY").is_none());
        assert!(environ_value(b"XAI_API_KEY", b"XAI_API_KEY").is_none());
        let found = secrets_in_environ(buf);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].1, b"yes");
        assert_eq!(found[2].1, b"db");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn handoff_roundtrip_keeps_bytes_that_look_like_framing() {
        let secrets = vec![
            ("XAI_API_KEY".to_string(), b"a=b\nc\0no".to_vec()),
            ("HARNESS_DB_KEY".to_string(), b"pass phrase".to_vec()),
        ];
        let encoded = encode_handoff(&secrets).unwrap();
        let decoded = decode_handoff(&encoded).unwrap();
        assert_eq!(decoded, secrets);
        assert!(decode_handoff(&encoded[..encoded.len() - 1]).is_err());
        let other = encode_handoff(&[("OTHER".into(), b"x".to_vec())]);
        assert!(other.is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn remove_var_leaves_the_secret_in_proc_environ() {
        if std::env::var_os("HARNESS_PROC_LEAK").is_some() {
            let api = std::env::var("XAI_API_KEY").expect("api key in the probe");
            let db = std::env::var("HARNESS_DB_KEY").expect("db key in the probe");
            // SAFETY: this probe process only. Shows what remove_var does not clear.
            unsafe {
                std::env::remove_var("XAI_API_KEY");
                std::env::remove_var("HARNESS_DB_KEY");
            }
            let initial = std::fs::read("/proc/self/environ").expect("self environ");
            assert!(
                initial
                    .windows(api.len())
                    .any(|window| window == api.as_bytes()),
                "remove_var cleared /proc/self/environ; the platform no longer keeps the initial block"
            );
            assert!(
                initial
                    .windows(db.len())
                    .any(|window| window == db.as_bytes()),
                "remove_var cleared the database key from /proc/self/environ"
            );
            assert!(std::env::var_os("XAI_API_KEY").is_none());
            let child = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg("cat /proc/$PPID/environ")
                .output()
                .expect("child");
            assert!(
                child.status.success(),
                "child could not read parent environ: {}",
                String::from_utf8_lossy(&child.stderr)
            );
            assert!(
                child
                    .stdout
                    .windows(api.len())
                    .any(|window| window == api.as_bytes()),
                "child did not see the api key in /proc/$PPID/environ"
            );
            assert!(
                child
                    .stdout
                    .windows(db.len())
                    .any(|window| window == db.as_bytes()),
                "child did not see the database key in /proc/$PPID/environ"
            );
            println!("leak_reproduced");
            println!("probe_done");
            return;
        }

        let api = random_secret("xai");
        let db = random_secret("dbk");
        let output = run_probe(
            "remove_var_leaves_the_secret_in_proc_environ",
            &[
                ("HARNESS_PROC_LEAK", "1"),
                ("XAI_API_KEY", &api),
                ("HARNESS_DB_KEY", &db),
            ],
        );
        assert!(
            output.success,
            "leak probe failed\nstdout:\n{}\nstderr:\n{}",
            output.stdout, output.stderr
        );
        assert!(
            output.stdout.contains("leak_reproduced"),
            "leak probe did not run\n{}",
            output.stdout
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn spawned_child_cannot_read_parent_secrets_from_proc() {
        if std::env::var_os("HARNESS_PROC_READER").is_some() {
            report_parent();
            return;
        }
        if std::env::var_os("HARNESS_PROC_FIX").is_none() {
            let api = random_secret("xai");
            let db = random_secret("dbk");
            let output = run_probe(
                "spawned_child_cannot_read_parent_secrets_from_proc",
                &[
                    ("HARNESS_PROC_FIX", "1"),
                    ("XAI_API_KEY", &api),
                    ("HARNESS_DB_KEY", &db),
                ],
            );
            assert!(
                output.success,
                "fix probe failed\nstdout:\n{}\nstderr:\n{}",
                output.stdout, output.stderr
            );
            assert!(
                output.stdout.contains("probe_done"),
                "fix probe did not finish\n{}",
                output.stdout
            );
            assert!(
                output.stdout.contains("Re-executing this process without"),
                "re-exec was not announced\n{}",
                output.stdout
            );
            assert!(
                output.stdout.contains("llm rnd - research and diagnostics harness"),
                "startup banner was not announced\n{}",
                output.stdout
            );
            assert!(
                !output.stdout.contains(&api) && !output.stdout.contains(&db),
                "probe stdout contained a secret"
            );
            return;
        }

        startup().expect("harden");
        let api = std::env::var("XAI_API_KEY").expect("handoff restored the api key");
        let db = std::env::var("HARNESS_DB_KEY").expect("handoff restored the db key");
        // Dumpable is 0, so this process cannot read its own environ. Lift
        // it just long enough to check the stack block, then put it back
        // before any child is spawned.
        set_dumpable_flag(1).expect("restore dumpable to inspect environ");
        let initial = std::fs::read(format!("/proc/{}/environ", std::process::id()))
            .expect("self environ while dumpable");
        set_dumpable_flag(0).expect("return to non-dumpable");
        assert!(
            !initial
                .windows(api.len())
                .any(|window| window == api.as_bytes()),
            "re-exec left the api key in /proc/self/environ"
        );
        assert!(
            !initial
                .windows(db.len())
                .any(|window| window == db.as_bytes()),
            "re-exec left the database key in /proc/self/environ"
        );

        let mut sleeper = std::process::Command::new("/bin/sleep")
            .arg("30")
            .env_remove("XAI_API_KEY")
            .env_remove("HARNESS_DB_KEY")
            .spawn()
            .expect("sleep");
        let start = crate::tools::capture::process_start_time(sleeper.id());
        let _ = sleeper.kill();
        let _ = sleeper.wait();
        assert!(
            start.is_some_and(|ticks| ticks > 0),
            "a non-dumpable child hid /proc/<pid>/stat starttime: {start:?}"
        );

        // SAFETY: this probe process only. The reader inherits the needle so
        // it knows what to look for. capture's env_remove still strips the
        // real secret names. set_var does not put the needle in /proc/environ.
        unsafe {
            std::env::set_var("HARNESS_PROC_READER", "1");
            std::env::set_var("HARNESS_PROC_NEEDLE", &api);
        }
        let exe = std::env::current_exe().expect("test executable");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let captured = runtime.block_on(crate::tools::capture::run(
            exe.as_path(),
            &[
                test_filter("spawned_child_cannot_read_parent_secrets_from_proc"),
                "--exact".into(),
                "--test-threads=1".into(),
                "--nocapture".into(),
            ],
            std::path::Path::new("."),
            std::time::Duration::from_secs(30),
            1024 * 1024,
        ));
        unsafe {
            std::env::remove_var("HARNESS_PROC_READER");
            std::env::remove_var("HARNESS_PROC_NEEDLE");
        }
        assert!(captured.spawn_error.is_none(), "{:?}", captured.spawn_error);
        let text = format!("{}{}", captured.stdout, captured.stderr);
        assert!(
            text.contains("reader_done"),
            "reader did not finish\n{text}"
        );
        assert!(text.contains("environ_errno=13"), "{text}");
        assert!(text.contains("environ_has_needle=0"), "{text}");
        assert!(text.contains("mem_errno=13"), "{text}");
        assert!(text.contains("mem_has_needle=0"), "{text}");
        assert!(text.contains("ptrace_errno=1"), "{text}");
        assert!(text.contains("inherited_api=0"), "{text}");
        assert!(text.contains("inherited_db=0"), "{text}");
        assert!(!text.contains(&api), "reader output contained the api key");
        assert!(!text.contains(&db), "reader output contained the db key");
        println!("probe_done");
    }

    #[cfg(target_os = "linux")]
    fn report_parent() {
        let ppid = std::os::unix::process::parent_id();
        let needle = std::env::var("HARNESS_PROC_NEEDLE").unwrap_or_default();
        let needle_bytes = needle.as_bytes();
        let environ_path = format!("/proc/{ppid}/environ");
        let mem_path = format!("/proc/{ppid}/mem");
        println!("environ_errno={}", open_errno(&environ_path));
        println!(
            "environ_has_needle={}",
            usize::from(file_contains(&environ_path, needle_bytes))
        );
        println!("mem_errno={}", open_errno(&mem_path));
        println!(
            "mem_has_needle={}",
            usize::from(!needle_bytes.is_empty() && parent_memory_has(ppid, needle_bytes))
        );
        println!("ptrace_errno={}", ptrace_errno(ppid as i32));
        println!(
            "inherited_api={}",
            usize::from(std::env::var_os("XAI_API_KEY").is_some())
        );
        println!(
            "inherited_db={}",
            usize::from(std::env::var_os("HARNESS_DB_KEY").is_some())
        );
        println!("reader_done");
    }

    #[cfg(target_os = "linux")]
    fn open_errno(path: &str) -> i32 {
        let Ok(c_path) = std::ffi::CString::new(path) else {
            return -1;
        };
        // SAFETY: `c_path` is a NUL-terminated path. The descriptor is closed
        // before return. This only checks whether the kernel allows the open.
        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDONLY) };
        if fd >= 0 {
            unsafe { libc::close(fd) };
            0
        } else {
            std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
        }
    }

    #[cfg(target_os = "linux")]
    fn file_contains(path: &str, needle: &[u8]) -> bool {
        if needle.is_empty() {
            return false;
        }
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|window| window == needle))
            .unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    fn parent_memory_has(ppid: u32, needle: &[u8]) -> bool {
        use std::os::unix::fs::FileExt;
        let Ok(maps) = std::fs::read_to_string(format!("/proc/{ppid}/maps")) else {
            return false;
        };
        let Ok(file) = std::fs::File::open(format!("/proc/{ppid}/mem")) else {
            return false;
        };
        for line in maps.lines() {
            let mut parts = line.split_whitespace();
            let Some(range) = parts.next() else { continue };
            let Some(perms) = parts.next() else { continue };
            if !perms.starts_with('r') {
                continue;
            }
            let Some((start_text, end_text)) = range.split_once('-') else {
                continue;
            };
            let Ok(start) = u64::from_str_radix(start_text, 16) else {
                continue;
            };
            let Ok(end) = u64::from_str_radix(end_text, 16) else {
                continue;
            };
            let span = end.saturating_sub(start);
            if span == 0 || span > 8 * 1024 * 1024 {
                continue;
            }
            let mut buf = vec![0u8; span as usize];
            let Ok(read) = file.read_at(&mut buf, start) else {
                continue;
            };
            if buf[..read]
                .windows(needle.len())
                .any(|window| window == needle)
            {
                return true;
            }
        }
        false
    }

    #[cfg(target_os = "linux")]
    fn ptrace_errno(ppid: i32) -> i32 {
        // SAFETY: attach either fails immediately for a non-dumpable parent
        // or stops that parent. On success we detach before returning.
        let rc = unsafe {
            libc::ptrace(
                libc::PTRACE_ATTACH,
                ppid,
                std::ptr::null_mut::<libc::c_void>(),
                std::ptr::null_mut::<libc::c_void>(),
            )
        };
        if rc == 0 {
            unsafe {
                libc::ptrace(
                    libc::PTRACE_DETACH,
                    ppid,
                    std::ptr::null_mut::<libc::c_void>(),
                    std::ptr::null_mut::<libc::c_void>(),
                );
            }
            return 0;
        }
        std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
    }

    #[cfg(target_os = "linux")]
    struct ProbeOutput {
        success: bool,
        stdout: String,
        stderr: String,
    }

    #[cfg(target_os = "linux")]
    fn run_probe(test_name: &str, vars: &[(&str, &str)]) -> ProbeOutput {
        let exe = std::env::current_exe().expect("test executable");
        let mut command = std::process::Command::new(exe);
        command
            .arg(test_filter(test_name))
            .arg("--exact")
            .arg("--test-threads=1")
            .arg("--nocapture")
            .env_remove(HANDOFF_FD_VAR)
            .env_remove("HARNESS_PROC_READER")
            .env_remove("HARNESS_PROC_NEEDLE")
            .env_remove("HARNESS_PROC_LEAK")
            .env_remove("HARNESS_PROC_FIX")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for (key, value) in vars {
            command.env(key, value);
        }
        let mut child = command.spawn().expect("probe");
        let started = std::time::Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().expect("probe wait") {
                break Some(status);
            }
            if started.elapsed() > std::time::Duration::from_secs(60) {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stdout.take() {
            let _ = std::io::Read::read_to_string(&mut pipe, &mut stdout);
        }
        if let Some(mut pipe) = child.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
        }
        ProbeOutput {
            success: status.is_some_and(|status| status.success()),
            stdout,
            stderr,
        }
    }

    #[cfg(target_os = "linux")]
    fn test_filter(test_name: &str) -> String {
        format!("harden::tests::{test_name}")
    }

    #[cfg(target_os = "linux")]
    fn random_secret(prefix: &str) -> String {
        let mut bytes = [0u8; 16];
        let mut file = std::fs::File::open("/dev/urandom").expect("urandom");
        std::io::Read::read_exact(&mut file, &mut bytes).expect("urandom");
        let mut text = String::from(prefix);
        text.push('-');
        for byte in bytes {
            text.push_str(&format!("{byte:02x}"));
        }
        text
    }
}
