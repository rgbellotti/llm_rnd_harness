//! Encrypted store for `XAI_API_KEY`, `REFLECTION_API_KEY`, and
//! `HARNESS_DB_KEY`. `REFLECTION_API_KEY` is optional: without it, Reflection
//! models stay out of the model selector's usable set.
//!
//! The file is `~/.config/harness-keys`, or `$XDG_CONFIG_HOME/harness-keys`,
//! or the path in `HARNESS_KEYS_FILE`. It lives off the workspace volume.
//! The bytes on disk are an age passphrase file. The password is typed at
//! each start. It is not written down, not printed, and not placed in the
//! environment.
//!
//! At the prompt, the password opens the file. The word `help` prints the
//! menu of everything else the prompt accepts, and never spends one of
//! the three login attempts. The menu lists the commands: the word
//! `change_password` asks for the current password, then the new password
//! twice, re-encrypts the file, and continues into the harness; the word
//! `set_key` asks for the current password, then a variable name and a
//! hidden value: a provider API key is added, updated, or (with an empty
//! value) removed, and the history passphrase can be replaced — the file
//! re-encrypts with the same password and the session continues. The word
//! `set_unreg_keys` walks only the variables without a value and offers
//! each one: hidden value, or empty to skip. The reserved words still
//! work typed directly; the menu only documents them. None of them can
//! be chosen as a password: the reserved word would always win at login.
//! The values inside do not change under `change_password`.
//!
//! The first start without a file asks once whether to encrypt now. Saying
//! y creates the file on the spot: a password is chosen, the history
//! passphrase is imported from the environment when one is there and
//! generated otherwise, provider keys found in the environment are
//! imported, and every unset key is offered (value or skip). Saying n
//! starts plain for testing — the choice is remembered by a tiny dated
//! marker beside the file's future path, and `--setup-keys` runs the
//! wizard again at any time. A plain start prints one note about what
//! that means each launch until encryption is set up.
//!
//! A short password such as `temp` or `aaa` is accepted while the harness
//! is still being tested. A 12-character minimum is deferred until the
//! harness is in full use. Do not add that minimum yet. An empty password
//! is refused. `HARNESS_DB_KEY` inside the file keeps its own 12-character
//! minimum. That is the history passphrase, not this password.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const AGE_HEADER: &[u8] = b"age-encryption.org/v1";
const MAX_KEYS_FILE_BYTES: u64 = 64 * 1024;
const MAX_PASSWORD_BYTES: usize = 1024;
const LOGIN_ATTEMPTS: usize = 3;
const RESERVED_PASSWORD: &str = "change_password";

/// Fast scrypt for tests. Production uses the age default, about a second.
#[cfg(test)]
const TEST_WORK_FACTOR: Option<u8> = Some(10);
#[cfg(not(test))]
const TEST_WORK_FACTOR: Option<u8> = None;

struct Loaded {
    provider_keys: std::collections::HashMap<&'static str, String>,
    db_key: Option<String>,
    /// True when these came out of the encrypted keys file (or the
    /// onboarding wizard that created it). False for the environment.
    from_file: bool,
}

static LOADED: OnceLock<Loaded> = OnceLock::new();

/// How this launch got its keys. History picks its mode from this
/// (session-only when no passphrase exists anywhere); the plain note at
/// startup is printed for the two non-encrypted kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StartupMode {
    /// The encrypted keys file was opened, or created by the onboarding
    /// wizard. The file's `HARNESS_DB_KEY` is the history passphrase.
    Encrypted,
    /// No file. Provider keys and the history passphrase came from the
    /// environment, so history still works on its real path.
    EnvImported,
    /// No file and no history passphrase anywhere: nothing persists, and
    /// history is session-only.
    PlainSession,
}

/// The classifier behind [`startup_mode`], separated so tests can cover
/// the mapping without touching the process-global `LOADED`.
fn classify_startup(from_file: bool, db_key: Option<&str>) -> StartupMode {
    if from_file {
        StartupMode::Encrypted
    } else if db_key.is_some() {
        StartupMode::EnvImported
    } else {
        StartupMode::PlainSession
    }
}

/// How the running harness got its keys. Call after `prepare`.
pub(crate) fn startup_mode() -> StartupMode {
    LOADED
        .get()
        .map(|loaded| classify_startup(loaded.from_file, loaded.db_key.as_deref()))
        // Before `prepare` this answers EnvImported so no caller treats
        // an unread state as the plain-session mode.
        .unwrap_or(StartupMode::EnvImported)
}

/// `Some` after [`prepare`]. The inner value is that provider's API key,
/// if one was stored. The key names are the provider registry's
/// `KEY_ENV_VARS`.
pub(crate) fn installed_provider_key(key_env: &str) -> Option<Option<String>> {
    LOADED
        .get()
        .map(|loaded| loaded.provider_keys.get(key_env).cloned())
}

/// True when `key_env` names a key that is usable now: stored in the
/// opened keys file, or (before `prepare` has loaded one) present in the
/// process environment. Mirrors what the provider clients cache.
pub(crate) fn provider_key_available(key_env: &str) -> bool {
    match LOADED.get() {
        Some(loaded) => loaded.provider_keys.contains_key(key_env),
        None => std::env::var(key_env)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .is_some(),
    }
}

/// `Some` after [`prepare`]. The inner value is the history passphrase, if stored.
pub(crate) fn installed_db_key() -> Option<Option<String>> {
    LOADED.get().map(|loaded| loaded.db_key.clone())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Secrets {
    provider_keys: std::collections::HashMap<&'static str, String>,
    db_key: String,
}

/// Read the keys file when it exists, or take the environment when it does not.
/// Call this once, before any tool process is spawned.
pub(crate) fn prepare() -> Result<(), String> {
    if LOADED.get().is_some() {
        return Ok(());
    }
    let Some(path) = keys_path() else {
        install_from_env();
        return Ok(());
    };
    refuse_symlinks(&path)?;
    recover(&path)?;
    if !path.is_file() {
        return start_without_file(&path);
    }
    if wants_setup_flag() {
        eprintln!(
            "harness-keys: {} already exists — opening it as usual. The {} wizard is for a first setup; use set_unreg_keys at the prompt to set any unset keys.",
            path.display(),
            SETUP_FLAG
        );
    }
    let secrets = match sniff(&path)? {
        FileKind::Encrypted => prompt_session(&path)?,
        FileKind::Plain => prompt_first_password(&path)?,
    };
    install(secrets);
    println!("harness-keys: opened {}", path.display());
    Ok(())
}

/// The CLI flag that re-runs the first-startup encryption wizard at any
/// time, even after the question was declined. `prepare` runs before the
/// CLI parse, so the flag is peeked from the raw arguments here and
/// `parse_cli` accepts it silently so it does not error later.
const SETUP_FLAG: &str = "--setup-keys";

fn wants_setup_flag() -> bool {
    std::env::args().skip(1).any(|arg| arg == SETUP_FLAG)
}

/// The marker a declined first-startup question leaves beside the file's
/// future path: plain, dated, no secrets. Its presence means the
/// question is never repeated; deleting it makes the next start ask
/// again, and `--setup-keys` runs the wizard regardless.
fn declined_marker_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".declined");
    PathBuf::from(name)
}

fn write_declined_marker(marker: &Path) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    if let Err(error) = std::fs::write(marker, format!("declined {stamp}\n")) {
        eprintln!(
            "harness-keys: could not write {} ({error}) — the first-startup question will appear again.",
            marker.display()
        );
    }
}

/// The default history location, best-effort, so the onboarding can warn
/// when a generated history passphrase starts a fresh record beside an
/// existing database. Advisory only: the authoritative choice lives in
/// `history::locate_history`.
fn default_history_path() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("HARNESS_DB_PATH")
        && !value.is_empty()
    {
        return Some(PathBuf::from(value));
    }
    let dir = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".local/share"))
        })?;
    Some(dir.join("harness/harness.db"))
}

/// The answer to the first-startup question. `remember` says whether a
/// declined answer should leave the marker: a plain "n" does, an
/// unanswerable terminal does not (nothing permanent is decided for the
/// person by a broken prompt).
#[derive(Debug)]
enum Onboarding {
    Encrypt(Secrets),
    Decline { remember: bool },
}

/// No keys file. Ask the first-startup question once (the declined
/// marker, or the setup flag, decides whether to ask), then either
/// continue into the harness with a freshly encrypted file or start
/// plain with the per-start note.
fn start_without_file(path: &Path) -> Result<(), String> {
    let marker = declined_marker_path(path);
    if !marker.is_file() || wants_setup_flag() {
        match Tty::open() {
            Ok(mut tty) => match prompt_onboarding(path, &mut tty)? {
                Onboarding::Encrypt(secrets) => {
                    install(secrets);
                    println!(
                        "harness-keys: created and encrypted {} — it opens with the password at each start.",
                        path.display()
                    );
                    return Ok(());
                }
                Onboarding::Decline { remember } => {
                    if remember {
                        write_declined_marker(&marker);
                    }
                }
            },
            Err(message) => {
                // No terminal to ask on: behave like a decline, but leave
                // no marker — a non-interactive start must not decide for
                // the person permanently.
                eprintln!("harness-keys: {message}");
            }
        }
    }
    // Plain start. The note states what actually loaded: which provider
    // keys the environment supplied, and — from the startup mode — what
    // this launch means for history.
    install_from_env();
    let imported: Vec<&'static str> = LOADED
        .get()
        .map(|loaded| {
            crate::providers::KEY_ENV_VARS
                .iter()
                .copied()
                .filter(|key_env| loaded.provider_keys.contains_key(key_env))
                .collect()
        })
        .unwrap_or_default();
    let db_key_from_env = matches!(startup_mode(), StartupMode::EnvImported);
    print_plain_note(path, &imported, db_key_from_env);
    Ok(())
}

/// The one-time question, with a bounded re-ask budget so a terminal that
/// cannot answer never wedges the startup: after the third unusable
/// answer the harness starts plain and unmarked.
fn prompt_onboarding(path: &Path, tty: &mut dyn PasswordPrompt) -> Result<Onboarding, String> {
    eprintln!("harness-keys: no encrypted keys file was found at {}.", path.display());
    eprintln!("Encrypting stores the provider API keys and the history passphrase in that file, behind a password typed at each start.");
    for _ in 0..LOGIN_ATTEMPTS {
        let answer = tty.line(
            "Encrypt your API keys and transcript history now? (y/n): ",
        )?;
        match answer.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" => return onboard_encrypted(path, tty).map(Onboarding::Encrypt),
            "n" | "no" => return Ok(Onboarding::Decline { remember: true }),
            other => eprintln!(
                "harness-keys: {other:?} is not y or n. y creates the file and chooses a password; n starts unencrypted (set up any time with {SETUP_FLAG})."
            ),
        }
    }
    eprintln!("harness-keys: no usable answer — starting without encryption for now.");
    Ok(Onboarding::Decline { remember: false })
}

/// The `y` path of the first-startup question: create the keys file from
/// nothing. The password is chosen here under the same rules the
/// plain-text first-encryption uses. The history passphrase is imported
/// from the environment when one is there (so existing history stays
/// readable) and generated otherwise; provider keys found in the
/// environment are imported (names printed, values never); the rest are
/// offered one by one — hidden value, or empty to skip.
fn onboard_encrypted(path: &Path, tty: &mut dyn PasswordPrompt) -> Result<Secrets, String> {
    let mut password = String::new();
    let mut have_password = false;
    for _ in 0..LOGIN_ATTEMPTS {
        let new = tty.hidden("New password: ")?;
        let confirm = tty.hidden("Confirm password: ")?;
        if let Err(reason) = check_new_password(&new) {
            eprintln!("harness-keys: {reason}");
            zero_string_owned(new);
            zero_string_owned(confirm);
            continue;
        }
        if new != confirm {
            eprintln!("harness-keys: the passwords do not match.");
            zero_string_owned(new);
            zero_string_owned(confirm);
            continue;
        }
        zero_string_owned(confirm);
        zero_string_owned(password);
        password = new;
        have_password = true;
        break;
    }
    if !have_password {
        return Err("harness-keys was not created. Start the harness again to choose a password.".into());
    }

    let mut provider_keys = std::collections::HashMap::new();
    let mut imported: Vec<&'static str> = Vec::new();
    for key_env in crate::providers::KEY_ENV_VARS.iter().copied() {
        if let Some(value) = take_env(key_env) {
            provider_keys.insert(key_env, value);
            imported.push(key_env);
        }
    }
    if imported.is_empty() {
        eprintln!("harness-keys: no provider keys were found in the environment.");
    } else {
        eprintln!(
            "harness-keys: imported from the environment: {}",
            imported.join(", ")
        );
    }
    // The history passphrase: keep the environment's when it is a valid
    // one (the existing history stays readable); generate otherwise.
    let (db_key, generated) = match take_env("HARNESS_DB_KEY") {
        Some(value) => match crate::history::normalize_passphrase(&value) {
            Ok(normalized) => (normalized, false),
            Err(reason) => {
                eprintln!(
                    "harness-keys: HARNESS_DB_KEY is not usable ({reason}). A new history passphrase was generated instead."
                );
                (generate_passphrase()?, true)
            }
        },
        None => (generate_passphrase()?, true),
    };
    if generated
        && default_history_path().is_some_and(|db| db.is_file())
    {
        eprintln!(
            "harness-keys: note — a new history passphrase was generated, so an existing history database will not open under it. It starts a fresh record."
        );
    }
    let mut secrets = Secrets {
        provider_keys,
        db_key,
    };
    let set = offer_unset_keys(&mut secrets, tty)?;
    if !set.is_empty() {
        eprintln!("harness-keys: set {}.", set.join(", "));
    }
    // The same guard every other write path has: the password must not be
    // one of the values it protects.
    if password_reuses_secret(&password, &secrets) {
        zero_string_owned(password);
        return Err(
            "harness-keys was not created: the password matches one of the stored values. Choose a different password and start the harness again.".into(),
        );
    }
    write_encrypted(path, &password, &secrets)?;
    zero_string_owned(password);
    Ok(secrets)
}

/// 32 bytes of `/dev/urandom`, hex. The generated history passphrase: the
/// person never types or sees it — the keys file's password protects it.
/// Also the session passphrase for a plain start, where nothing on disk
/// can be reopened under it anyway. A missing `/dev/urandom` refuses to
/// start, the same posture as the launch token: a predictable passphrase
/// would quietly turn a broken system into a guessable key.
pub(crate) fn generate_passphrase() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    let mut file = std::fs::File::open("/dev/urandom")
        .map_err(|error| format!("could not open /dev/urandom ({error}); refusing to generate a history passphrase"))?;
    file.read_exact(&mut bytes)
        .map_err(|error| format!("could not read /dev/urandom ({error}); refusing to generate a history passphrase"))?;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    Ok(out)
}

/// Walk the variables without a value and offer each one: a hidden value
/// sets it, an empty answer skips it. Never touches a slot that already
/// has a value and never offers the history passphrase (it always has
/// one by the time this runs; `set_key` replaces it). Shared by the
/// onboarding wizard and the `set_unreg_keys` prompt word.
fn offer_unset_keys(
    secrets: &mut Secrets,
    tty: &mut dyn PasswordPrompt,
) -> Result<Vec<&'static str>, String> {
    let mut set = Vec::new();
    for key_env in crate::providers::KEY_ENV_VARS.iter().copied() {
        if secrets.provider_keys.contains_key(key_env) {
            continue;
        }
        let value = tty.hidden(&format!(
            "{key_env} (enter the hidden value, or empty to skip): "
        ))?;
        if value.trim().is_empty() {
            zero_string_owned(value);
            continue;
        }
        if value.contains(['\'', '\n', '\r']) {
            zero_string_owned(value);
            eprintln!(
                "harness-keys: {key_env} was skipped — the value contains a quote or a newline."
            );
            continue;
        }
        secrets.provider_keys.insert(key_env, value);
        set.push(key_env);
    }
    Ok(set)
}

/// The quiet per-start note for a launch without encryption: what is
/// actually in use, how to change that, and how to keep sessions
/// without it. Printed once per start, blocks nothing.
fn print_plain_note(path: &Path, imported: &[&'static str], db_key_from_env: bool) {
    let marker = declined_marker_path(path);
    let names = if imported.is_empty() {
        "none imported".to_string()
    } else {
        imported.join(", ")
    };
    if db_key_from_env {
        eprintln!(
            "harness-keys: not encrypted — provider keys and the history passphrase come from the environment ({names}). Transcript history records to the real database. Start with {SETUP_FLAG} (or delete {} and restart) to set up encryption.",
            marker.display()
        );
    } else {
        eprintln!(
            "harness-keys: not encrypted — provider keys come from the environment ({names}), and history is session-only: it works this session, is not saved to disk, and transcript histories are not kept without encryption setup. Set up encryption by starting with {SETUP_FLAG} (or delete {} and restart), or export sessions to HTML/JSON/Text to keep them.",
            marker.display()
        );
    }
}

fn keys_path() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("HARNESS_KEYS_FILE")
        && !value.is_empty()
    {
        return Some(PathBuf::from(value));
    }
    let dir = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".config"))
        })?;
    Some(dir.join("harness-keys"))
}

fn install(secrets: Secrets) {
    let mut provider_keys = secrets.provider_keys;
    // The keys file wins per variable: only take the environment value
    // when the file did not provide that one.
    for key_env in crate::providers::KEY_ENV_VARS.iter().copied() {
        if !provider_keys.contains_key(key_env)
            && let Some(value) = take_env(key_env)
        {
            provider_keys.insert(key_env, value);
        }
    }
    let _env_db = take_env("HARNESS_DB_KEY");
    let _ = LOADED.set(Loaded {
        provider_keys,
        db_key: Some(secrets.db_key),
        from_file: true,
    });
}

fn install_from_env() {
    let mut provider_keys = std::collections::HashMap::new();
    for key_env in crate::providers::KEY_ENV_VARS.iter().copied() {
        if let Some(value) = take_env(key_env) {
            provider_keys.insert(key_env, value);
        }
    }
    let _ = LOADED.set(Loaded {
        provider_keys,
        db_key: take_env("HARNESS_DB_KEY"),
        from_file: false,
    });
}

fn take_env(name: &str) -> Option<String> {
    let value = std::env::var(name).ok();
    // SAFETY: startup, before tool processes. Removes a secret the harness
    // just read so a later child cannot inherit it. This does not clear
    // `/proc/<pid>/environ`; `harden::startup` re-execs and marks the
    // process non-dumpable for that.
    unsafe { std::env::remove_var(name) };
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

enum FileKind {
    Encrypted,
    Plain,
}

fn sniff(path: &Path) -> Result<FileKind, String> {
    let meta = std::fs::metadata(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_KEYS_FILE_BYTES {
        return Err(format!("{} is too large", path.display()));
    }
    let bytes = read_limited(path)?;
    if bytes.starts_with(AGE_HEADER) {
        Ok(FileKind::Encrypted)
    } else {
        Ok(FileKind::Plain)
    }
}

fn prompt_session(path: &Path) -> Result<Secrets, String> {
    let mut tty = Tty::open()?;
    run_session(path, &mut tty)
}

fn prompt_first_password(path: &Path) -> Result<Secrets, String> {
    eprintln!(
        "harness-keys: {} is plain text. Choose a password. You will type it each time the harness starts.",
        path.display()
    );
    let mut tty = Tty::open()?;
    for _ in 0..LOGIN_ATTEMPTS {
        let new = tty.hidden("New password: ")?;
        let confirm = tty.hidden("Confirm password: ")?;
        if let Err(reason) = check_new_password(&new) {
            eprintln!("harness-keys: {reason}");
            zero_string_owned(new);
            zero_string_owned(confirm);
            continue;
        }
        if new != confirm {
            eprintln!("harness-keys: the passwords do not match.");
            zero_string_owned(new);
            zero_string_owned(confirm);
            continue;
        }
        let secrets = seal_plaintext(path, &new)?;
        zero_string_owned(new);
        zero_string_owned(confirm);
        eprintln!("harness-keys: encrypted. The plain text was overwritten.");
        return Ok(secrets);
    }
    Err("harness-keys was not encrypted. Start the harness again to choose a password.".into())
}

/// Reserved at the password prompt: print the menu of what the prompt
/// accepts. Never consumes a login attempt — a menu is not a try.
const RESERVED_HELP: &str = "help";

/// Reserved at the password prompt: walk the variables without a value
/// and offer each one (hidden value, or empty to skip). The same walk the
/// onboarding wizard uses, available any time a provider joined the
/// registry since the last start.
const RESERVED_SET_UNREG: &str = "set_unreg_keys";

/// Every word that means a command at the login prompt. None of them can
/// be chosen as a password: the reserved word would always win at login
/// and the real password would become unreachable.
const RESERVED_PROMPT_WORDS: &[&str] = &[
    RESERVED_PASSWORD,
    RESERVED_SET_KEY,
    RESERVED_SET_UNREG,
    RESERVED_HELP,
];

/// The `help` menu at the password prompt. The variable names come from
/// the provider registry, so a provider added there lists itself here
/// without this file changing.
fn print_prompt_help() {
    let accepted: Vec<&str> = crate::providers::secret_env_vars().collect();
    let list = accepted.join(", ");
    eprintln!(
        "\
harness-keys: this prompt unlocks the encrypted keys file each start.

  (password)      Type the file's password to open it and continue.

  set_key         Add, update, or remove one stored secret: asks for the
                  current password, then one of the variables: 
                      {list}
                  then the key value. That sets or changes a provider
                  API key, or replaces the history.db passphrase
                  (HARNESS_DB_KEY). An empty value removes a provider key;
                  the history passphrase cannot be removed, only
                  replaced — and a replacement starts a new history
                  record, so the existing history will not open under it.

  set_unreg_keys  Asks for the current password, then offers every
                  variable that has no value yet, one at a time: enter the
                  key value, or empty to skip. Handy after a provider
                  joins the registry; re-encrypts with the same password.

  change_password Asks for the current password, then the new password
                  twice, and re-encrypts the file with it. The stored
                  values inside are untouched.

  help            This menu.

The file is ~/.config/harness-keys (or $XDG_CONFIG_HOME/harness-keys, or
the path in HARNESS_KEYS_FILE). With no file yet, the first start asks
whether to encrypt now: y creates the file on the spot — you choose the
password, the history passphrase is generated for you, provider keys
found in the environment are imported, and the rest are offered one by
one. n starts unencrypted to try the harness first; a small marker
remembers that answer, and starting with {SETUP_FLAG} runs the same
wizard at any time."
    );
}

fn run_session(path: &Path, tty: &mut dyn PasswordPrompt) -> Result<Secrets, String> {
    // `help` reprints the menu without spending an attempt, so the three
    // tries stay three real tries at the password.
    let mut attempts = 0;
    loop {
        let entry = tty.hidden("harness-keys password (or 'help' for more options): ")?;
        if entry == RESERVED_HELP {
            zero_string_owned(entry);
            print_prompt_help();
            continue;
        }
        if attempts >= LOGIN_ATTEMPTS {
            zero_string_owned(entry);
            return Err("harness-keys did not open. Start the harness again and enter the password.".into());
        }
        attempts += 1;
        if entry == RESERVED_PASSWORD {
            zero_string_owned(entry);
            match change_with_prompt(path, tty) {
                Ok(secrets) => return Ok(secrets),
                Err(SessionError::Retry(message)) => {
                    eprintln!("harness-keys: {message}");
                    continue;
                }
                Err(SessionError::Stop(message)) => return Err(message),
            }
        }
        if entry == RESERVED_SET_KEY {
            zero_string_owned(entry);
            match set_key_with_prompt(path, tty) {
                Ok(secrets) => return Ok(secrets),
                Err(SessionError::Retry(message)) => {
                    eprintln!("harness-keys: {message}");
                    continue;
                }
                Err(SessionError::Stop(message)) => return Err(message),
            }
        }
        if entry == RESERVED_SET_UNREG {
            zero_string_owned(entry);
            match set_unreg_with_prompt(path, tty) {
                Ok(secrets) => return Ok(secrets),
                Err(SessionError::Retry(message)) => {
                    eprintln!("harness-keys: {message}");
                    continue;
                }
                Err(SessionError::Stop(message)) => return Err(message),
            }
        }
        if entry.is_empty() {
            eprintln!("harness-keys: the password is empty.");
            continue;
        }
        match unlock_file(path, &entry) {
            Ok(secrets) => {
                zero_string_owned(entry);
                return Ok(secrets);
            }
            Err(message) => {
                zero_string_owned(entry);
                eprintln!("harness-keys: {message}");
            }
        }
    }
}

enum SessionError {
    Retry(String),
    Stop(String),
}

/// Reserved at the password prompt: add, update, or remove one secret in
/// the encrypted keys file, then open it as usual.
const RESERVED_SET_KEY: &str = "set_key";

/// The `set_key` flow at the startup prompt. The current password opens
/// the file, one variable changes, and the file is re-encrypted with the
/// SAME password through the same crash-safe commit the first-launch
/// encryption and `change_password` use. On success the session continues
/// with the updated secrets.
///
/// The acceptable variable names are the provider registry's key list plus
/// the history passphrase — the same single list every scrub and parse
/// site derives from, so a provider added to the registry is settable here
/// without touching this file. A provider key with an empty value is
/// removed; the history passphrase is never removable (the file must
/// always carry one), only replaceable — with a warning that the existing
/// history will not open under the new passphrase.
fn set_key_with_prompt(path: &Path, tty: &mut dyn PasswordPrompt) -> Result<Secrets, SessionError> {
    let current = tty
        .hidden("Current password: ")
        .map_err(SessionError::Stop)?;
    let mut secrets = match unlock_file(path, &current) {
        Ok(secrets) => secrets,
        Err(message) => {
            zero_string_owned(current);
            return Err(SessionError::Retry(message));
        }
    };
    let accepted: Vec<&str> = crate::providers::secret_env_vars().collect();
    let list = accepted.join(", ");
    for _ in 0..LOGIN_ATTEMPTS {
        let name = match tty.line(&format!("Variable ({list}): ")) {
            Ok(name) => name.trim().to_string(),
            Err(message) => {
                zero_string_owned(current);
                return Err(SessionError::Stop(message));
            }
        };
        let Some(slot) = accepted.iter().copied().find(|known| *known == name) else {
            eprintln!("harness-keys: {name} is not a harness secret. Use one of: {list}.");
            continue;
        };
        let value = match tty.hidden("New value (hidden; empty removes): ") {
            Ok(value) => value,
            Err(message) => {
                zero_string_owned(current);
                return Err(SessionError::Stop(message));
            }
        };
        let outcome = if value.trim().is_empty() {
            zero_string_owned(value);
            if slot == "HARNESS_DB_KEY" {
                Err("the history passphrase cannot be removed; the file always carries one.".into())
            } else {
                match secrets.provider_keys.remove(slot) {
                    Some(_) => Ok("removed".to_string()),
                    None => Ok("was already absent".to_string()),
                }
            }
        } else {
            let value = value.trim().to_string();
            let result = if value.contains(['\'', '\n', '\r']) {
                Err("the value contains a quote or a newline, which the keys file cannot store.".to_string())
            } else if slot == "HARNESS_DB_KEY" {
                match crate::history::normalize_passphrase(&value) {
                    Ok(normalized) => {
                        eprintln!(
                            "harness-keys: a new history passphrase will NOT open the existing history file. It starts a new encrypted record."
                        );
                        secrets.db_key = normalized;
                        Ok("set".to_string())
                    }
                    Err(message) => Err(message),
                }
            } else {
                secrets.provider_keys.insert(slot, value.clone());
                Ok("set".to_string())
            };
            zero_string_owned(value);
            result
        };
        match outcome {
            Err(reason) => {
                eprintln!("harness-keys: {reason}");
                continue;
            }
            Ok(verb) => {
                if let Err(message) = write_encrypted(path, &current, &secrets) {
                    zero_string_owned(current);
                    return Err(SessionError::Stop(message));
                }
                eprintln!(
                    "harness-keys: {slot} {verb}. The file was re-encrypted with the same password."
                );
                zero_string_owned(current);
                return Ok(secrets);
            }
        }
    }
    zero_string_owned(current);
    Err(SessionError::Stop(
        "the keys file was not changed. Start the harness again.".into(),
    ))
}

/// The `set_unreg_keys` flow at the startup prompt. The current password
/// opens the file, every variable without a value is offered once —
/// hidden value, or empty to skip — and the file re-encrypts with the
/// SAME password through the same crash-safe commit `set_key` uses.
/// When every variable already has a value the file is not rewritten.
fn set_unreg_with_prompt(
    path: &Path,
    tty: &mut dyn PasswordPrompt,
) -> Result<Secrets, SessionError> {
    let current = tty
        .hidden("Current password: ")
        .map_err(SessionError::Stop)?;
    let mut secrets = match unlock_file(path, &current) {
        Ok(secrets) => secrets,
        Err(message) => {
            zero_string_owned(current);
            return Err(SessionError::Retry(message));
        }
    };
    let set = offer_unset_keys(&mut secrets, tty).map_err(SessionError::Stop)?;
    if set.is_empty() {
        eprintln!(
            "harness-keys: every variable already has a value; nothing to set. Use set_key to change one."
        );
    } else {
        if let Err(message) = write_encrypted(path, &current, &secrets) {
            zero_string_owned(current);
            return Err(SessionError::Stop(message));
        }
        eprintln!(
            "harness-keys: {} set. The file was re-encrypted with the same password.",
            set.join(", ")
        );
    }
    zero_string_owned(current);
    Ok(secrets)
}

fn change_with_prompt(path: &Path, tty: &mut dyn PasswordPrompt) -> Result<Secrets, SessionError> {
    let current = tty
        .hidden("Current password: ")
        .map_err(SessionError::Stop)?;
    let secrets = match unlock_file(path, &current) {
        Ok(secrets) => secrets,
        Err(message) => {
            zero_string_owned(current);
            return Err(SessionError::Retry(message));
        }
    };
    zero_string_owned(current);
    for _ in 0..LOGIN_ATTEMPTS {
        let new = tty.hidden("New password: ").map_err(SessionError::Stop)?;
        let confirm = tty
            .hidden("Confirm new password: ")
            .map_err(SessionError::Stop)?;
        if let Err(reason) = check_new_password(&new) {
            eprintln!("harness-keys: {reason}");
            zero_string_owned(new);
            zero_string_owned(confirm);
            continue;
        }
        if new != confirm {
            eprintln!("harness-keys: the new passwords do not match.");
            zero_string_owned(new);
            zero_string_owned(confirm);
            continue;
        }
        if password_reuses_secret(&new, &secrets) {
            eprintln!(
                "harness-keys: choose a password that is not the API key or the history passphrase."
            );
            zero_string_owned(new);
            zero_string_owned(confirm);
            continue;
        }
        let updated = match change_file_password(path, &secrets, &new) {
            Ok(updated) => updated,
            Err(message) => {
                zero_string_owned(new);
                zero_string_owned(confirm);
                return Err(SessionError::Stop(message));
            }
        };
        zero_string_owned(new);
        zero_string_owned(confirm);
        eprintln!("harness-keys: password changed");
        return Ok(updated);
    }
    Err(SessionError::Stop(
        "the password was not changed. Start the harness again.".into(),
    ))
}

fn check_new_password(password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Err("the password is empty.".into());
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err("that password is too long.".into());
    }
    if RESERVED_PROMPT_WORDS.contains(&password) {
        return Err(
            "that word is reserved at the login prompt. Choose another password.".into(),
        );
    }
    Ok(())
}

fn password_reuses_secret(password: &str, secrets: &Secrets) -> bool {
    password == secrets.db_key
        || secrets
            .provider_keys
            .values()
            .any(|key| password == key)
}

fn unlock_file(path: &Path, password: &str) -> Result<Secrets, String> {
    refuse_symlinks(path)?;
    eprintln!("harness-keys: checking the password…");
    let bytes = read_limited(path)?;
    let plain = decrypt_bytes(password, &bytes)?;
    let text = String::from_utf8(plain)
        .map_err(|_| "harness-keys decrypted, but the contents are not text.".to_string())?;
    let secrets = parse_assignments(&text);
    zero_string_owned(text);
    secrets
}

fn seal_plaintext(path: &Path, password: &str) -> Result<Secrets, String> {
    refuse_symlinks(path)?;
    check_new_password(password)?;
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let secrets = parse_assignments(&text)?;
    if password_reuses_secret(password, &secrets) {
        return Err("choose a password that is not the API key or the history passphrase.".into());
    }
    write_encrypted(path, password, &secrets)?;
    Ok(secrets)
}

fn change_file_password(
    path: &Path,
    secrets: &Secrets,
    new_password: &str,
) -> Result<Secrets, String> {
    check_new_password(new_password)?;
    write_encrypted(path, new_password, secrets)?;
    Ok(secrets.clone())
}

fn write_encrypted(path: &Path, password: &str, secrets: &Secrets) -> Result<(), String> {
    eprintln!("harness-keys: securing the file…");
    let rendered = render_assignments(secrets)?;
    let encrypted = encrypt_bytes(password, rendered.as_bytes())?;
    zero_string_owned(rendered);
    let opened = decrypt_bytes(password, &encrypted)?;
    let round_trip = String::from_utf8(opened)
        .map_err(|_| "harness-keys could not be read back after encryption.".to_string())?;
    let checked = parse_assignments(&round_trip)?;
    zero_string_owned(round_trip);
    if checked != *secrets {
        return Err("harness-keys did not round-trip. The file was left unchanged.".into());
    }
    commit_file(path, &encrypted)
}

fn encrypt_bytes(password: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let secret = age::secrecy::SecretString::from(password.to_owned());
    let mut recipient = age::scrypt::Recipient::new(secret);
    if let Some(log_n) = TEST_WORK_FACTOR {
        recipient.set_work_factor(log_n);
    }
    age::encrypt(&recipient, plaintext).map_err(|_| "could not encrypt harness-keys".to_string())
}

fn decrypt_bytes(password: &str, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let secret = age::secrecy::SecretString::from(password.to_owned());
    let identity = age::scrypt::Identity::new(secret);
    age::decrypt(&identity, ciphertext)
        .map_err(|_| "that password does not open harness-keys.".to_string())
}

fn parse_assignments(text: &str) -> Result<Secrets, String> {
    let mut provider_keys: std::collections::HashMap<&'static str, String> =
        std::collections::HashMap::new();
    let mut db_key = None;
    for (index, raw) in text.lines().enumerate() {
        let line_number = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some((name, value)) = line.split_once('=') else {
            return Err(format!("line {line_number} is not an assignment"));
        };
        let name = name.trim();
        let value = unquote(value.trim());
        if value.contains(['\n', '\r', '\'']) {
            return Err(format!(
                "line {line_number} has a quote or a newline in the value"
            ));
        }
        // Provider API keys: one line each, in the registry's list. Every
        // scrub site derives from that same list, so a provider added to
        // the registry parses here without touching this function.
        if let Some(key_env) = crate::providers::KEY_ENV_VARS
            .iter()
            .find(|known| **known == name)
        {
            if value.trim().is_empty() {
                return Err(format!("{name} is empty"));
            }
            if provider_keys
                .insert(key_env, value.trim().to_string())
                .is_some()
            {
                return Err(format!("{name} is set more than once"));
            }
        } else {
            match name {
                "HARNESS_DB_KEY" => {
                    if db_key.is_some() {
                        return Err("HARNESS_DB_KEY is set more than once".into());
                    }
                    db_key = Some(crate::history::normalize_passphrase(&value)?);
                }
                _ => return Err(format!("line {line_number} names an unknown variable")),
            }
        }
    }
    let Some(db_key) = db_key else {
        return Err("harness-keys is missing HARNESS_DB_KEY".into());
    };
    Ok(Secrets { provider_keys, db_key })
}

fn render_assignments(secrets: &Secrets) -> Result<String, String> {
    let mut text = String::new();
    // Fixed order: the provider registry's list, then the history
    // passphrase. Re-encrypting is byte-stable across launches.
    for key_env in crate::providers::KEY_ENV_VARS {
        if let Some(value) = secrets.provider_keys.get(*key_env) {
            push_assignment(&mut text, key_env, value)?;
        }
    }
    push_assignment(&mut text, "HARNESS_DB_KEY", &secrets.db_key)?;
    Ok(text)
}

fn push_assignment(text: &mut String, name: &str, value: &str) -> Result<(), String> {
    if value.contains(['\n', '\r', '\'']) {
        return Err(format!(
            "{name} cannot be stored because it contains a quote or a newline"
        ));
    }
    text.push_str(name);
    text.push_str("='");
    text.push_str(value);
    text.push_str("'\n");
    Ok(())
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'\'' && last == b'\'') || (first == b'"' && last == b'"') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let mut limited = file.take(MAX_KEYS_FILE_BYTES + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_KEYS_FILE_BYTES {
        return Err(format!("{} is too large", path.display()));
    }
    Ok(bytes)
}

fn commit_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    refuse_symlinks(path)?;
    let encrypting = sibling(path, ".encrypting");
    let replaced = sibling(path, ".replaced");
    if encrypting.exists() {
        wipe_file(&encrypting);
    }
    write_private(&encrypting, bytes)?;
    if path.exists() {
        std::fs::rename(path, &replaced).map_err(|error| {
            wipe_file(&encrypting);
            format!("could not move the old harness-keys file: {error}")
        })?;
    }
    if let Err(error) = std::fs::rename(&encrypting, path) {
        if replaced.exists() && !path.exists() {
            let _ = std::fs::rename(&replaced, path);
        }
        wipe_file(&encrypting);
        return Err(format!("could not replace harness-keys: {error}"));
    }
    wipe_file(&replaced);
    Ok(())
}

fn recover(path: &Path) -> Result<(), String> {
    refuse_symlinks(path)?;
    let encrypting = sibling(path, ".encrypting");
    let replaced = sibling(path, ".replaced");
    let path_ok = path.is_file();
    let encrypting_ok = encrypting.is_file();
    let replaced_ok = replaced.is_file();
    if path_ok && replaced_ok {
        wipe_file(&replaced);
    } else if !path_ok && replaced_ok && encrypting_ok {
        std::fs::rename(&encrypting, path)
            .map_err(|error| format!("could not finish encrypting harness-keys: {error}"))?;
        wipe_file(&replaced);
    } else if !path_ok && replaced_ok {
        std::fs::rename(&replaced, path)
            .map_err(|error| format!("could not restore harness-keys: {error}"))?;
    } else if path_ok && encrypting_ok {
        wipe_file(&encrypting);
    }
    Ok(())
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "harness-keys".into());
    name.push(suffix);
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

fn refuse_symlinks(path: &Path) -> Result<(), String> {
    for candidate in [
        path.to_path_buf(),
        sibling(path, ".encrypting"),
        sibling(path, ".replaced"),
    ] {
        if let Ok(meta) = std::fs::symlink_metadata(&candidate)
            && meta.file_type().is_symlink()
        {
            return Err(format!(
                "{} is a symlink. Refusing to read or write it.",
                candidate.display()
            ));
        }
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        return Err(format!("directory {} does not exist", parent.display()));
    }
    let _ = std::fs::remove_file(path);
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
    };
    #[cfg(not(unix))]
    let file = OpenOptions::new().write(true).create_new(true).open(path);
    let mut file = file.map_err(|error| format!("could not create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("could not store {}: {error}", path.display()))?;
    Ok(())
}

fn wipe_file(path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if !meta.is_file() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().write(true).open(path) {
        let zeros = vec![0u8; 64 * 1024];
        let mut left = meta.len();
        while left > 0 {
            let count = std::cmp::min(left, zeros.len() as u64) as usize;
            if file.write_all(&zeros[..count]).is_err() {
                break;
            }
            left -= count as u64;
        }
        let _ = file.sync_all();
    }
    let _ = std::fs::remove_file(path);
}

fn zero_string_owned(value: String) {
    let mut bytes = value.into_bytes();
    for byte in &mut bytes {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

trait PasswordPrompt {
    fn hidden(&mut self, prompt: &str) -> Result<String, String>;
    /// A visible line read, for non-secret answers (the variable name in
    /// the `set_key` flow). The terminal's own line editing applies.
    fn line(&mut self, prompt: &str) -> Result<String, String>;
}

struct Tty {
    file: std::fs::File,
}

impl Tty {
    fn open() -> Result<Self, String> {
        let file = OpenOptions::new().read(true).write(true).open("/dev/tty").map_err(|_| {
            "harness-keys needs a terminal to read the password. Start the harness from a terminal."
                .to_string()
        })?;
        Ok(Self { file })
    }
}

impl PasswordPrompt for Tty {
    fn hidden(&mut self, prompt: &str) -> Result<String, String> {
        #[cfg(unix)]
        {
            read_hidden(&mut self.file, prompt)
        }
        #[cfg(not(unix))]
        {
            let _ = prompt;
            Err("harness-keys password entry is supported on Unix.".into())
        }
    }

    fn line(&mut self, prompt: &str) -> Result<String, String> {
        use std::io::{BufRead, BufReader, Write};
        let mut reader = BufReader::new(&mut self.file);
        reader
            .get_mut()
            .write_all(prompt.as_bytes())
            .and_then(|_| reader.get_mut().flush())
            .map_err(|error| format!("could not prompt for the answer: {error}"))?;
        let mut text = String::new();
        let read = reader
            .read_line(&mut text)
            .map_err(|error| format!("could not read the answer: {error}"))?;
        if read == 0 {
            return Err("the terminal closed while reading the answer.".into());
        }
        while text.ends_with('\n') || text.ends_with('\r') {
            text.pop();
        }
        Ok(text)
    }
}

#[cfg(unix)]
fn read_hidden(tty: &mut std::fs::File, prompt: &str) -> Result<String, String> {
    use std::os::fd::AsRawFd;
    let fd = tty.as_raw_fd();
    let mut original = std::mem::MaybeUninit::<libc::termios>::uninit();
    let rc = unsafe { libc::tcgetattr(fd, original.as_mut_ptr()) };
    if rc != 0 {
        return Err("could not read the terminal settings for the harness-keys password".into());
    }
    let original = unsafe { original.assume_init() };
    let _guard = EchoGuard { fd, original };
    let mut raw = original;
    raw.c_lflag &= !(libc::ECHO | libc::ECHONL | libc::ICANON);
    raw.c_cc[libc::VMIN] = 1;
    raw.c_cc[libc::VTIME] = 0;
    let rc = unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) };
    if rc != 0 {
        return Err("could not hide the harness-keys password".into());
    }
    tty.write_all(prompt.as_bytes())
        .map_err(|error| format!("could not prompt for the password: {error}"))?;
    tty.flush()
        .map_err(|error| format!("could not prompt for the password: {error}"))?;
    let mut bytes = Vec::new();
    let mut one = [0u8; 1];
    loop {
        let count = tty
            .read(&mut one)
            .map_err(|error| format!("could not read the password: {error}"))?;
        if count == 0 {
            return Err("end of input while reading the harness-keys password".into());
        }
        match one[0] {
            b'\n' | b'\r' => {
                let _ = tty.write_all(b"\n");
                let _ = tty.flush();
                break;
            }
            0x03 => {
                let _ = tty.write_all(b"\n");
                let _ = tty.flush();
                zero_bytes(&mut bytes);
                std::process::exit(130);
            }
            0x7f | 0x08 => pop_utf8_char(&mut bytes),
            0x15 => zero_bytes(&mut bytes),
            byte if byte < 0x20 => {}
            byte => bytes.push(byte),
        }
    }
    let text = String::from_utf8(bytes).map_err(|_| "the password must be text".to_string())?;
    let trimmed = text.trim().to_string();
    zero_string_owned(text);
    if trimmed.len() > MAX_PASSWORD_BYTES {
        zero_string_owned(trimmed);
        return Err("that password is too long.".into());
    }
    Ok(trimmed)
}

#[cfg(unix)]
struct EchoGuard {
    fd: i32,
    original: libc::termios,
}

#[cfg(unix)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.original) };
    }
}

fn pop_utf8_char(bytes: &mut Vec<u8>) {
    bytes.pop();
    while bytes
        .last()
        .is_some_and(|byte| byte & 0b1100_0000 == 0b1000_0000)
    {
        bytes.pop();
    }
}

fn zero_bytes(bytes: &mut Vec<u8>) {
    for byte in bytes.iter_mut() {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    bytes.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Script {
        lines: Vec<String>,
        next: usize,
    }

    impl Script {
        fn new(lines: &[&str]) -> Self {
            Self {
                lines: lines.iter().map(|line| (*line).to_string()).collect(),
                next: 0,
            }
        }
    }

    impl PasswordPrompt for Script {
        fn hidden(&mut self, _prompt: &str) -> Result<String, String> {
            let line = self
                .lines
                .get(self.next)
                .cloned()
                .ok_or_else(|| "the test prompt ran out of answers".to_string())?;
            self.next += 1;
            Ok(line)
        }

        fn line(&mut self, _prompt: &str) -> Result<String, String> {
            self.hidden(_prompt)
        }
    }

    struct TempKeys {
        dir: PathBuf,
    }

    impl TempKeys {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "harness-keys-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn path(&self) -> PathBuf {
            self.dir.join("harness-keys")
        }
    }

    impl Drop for TempKeys {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn sample() -> &'static str {
        "\
# local secrets\n\
export XAI_API_KEY='test-api-key'\n\
HARNESS_DB_KEY='history test key'\n"
    }

    fn write_sample(path: &Path) {
        std::fs::write(path, sample()).unwrap();
        #[cfg(unix)]
        {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }

    #[test]
    fn assignments_keep_the_two_secrets_and_refuse_a_short_history_passphrase() {
        let secrets = parse_assignments(sample()).unwrap();
        assert_eq!(
            secrets.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("test-api-key")
        );
        assert_eq!(secrets.db_key, "history test key");
        let missing = parse_assignments("XAI_API_KEY='test-api-key'\n").unwrap_err();
        assert!(missing.contains("HARNESS_DB_KEY"), "{missing}");
        let short = parse_assignments("HARNESS_DB_KEY='aaa'\n").unwrap_err();
        assert!(short.contains("12"), "{short}");
        assert!(!short.contains("aaa"), "{short}");
    }

    #[test]
    fn a_short_password_encrypts_the_file_and_the_secrets_are_not_on_disk() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        let secrets = seal_plaintext(&path, "temp").unwrap();
        assert_eq!(
            secrets.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("test-api-key")
        );
        let stored = std::fs::read(&path).unwrap();
        assert!(stored.starts_with(AGE_HEADER), "{stored:?}");
        assert!(
            !stored
                .windows(b"test-api-key".len())
                .any(|window| window == b"test-api-key")
        );
        assert!(
            !stored
                .windows(b"history test key".len())
                .any(|window| window == b"history test key")
        );
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        let opened = unlock_file(&path, "aaa");
        assert!(opened.is_err());
        let message = opened.unwrap_err();
        assert!(message.contains("does not open"), "{message}");
        assert!(!message.contains("aaa"), "{message}");
        assert!(!message.contains("test-api-key"), "{message}");
        let again = unlock_file(&path, "temp").unwrap();
        assert_eq!(again, secrets);
    }

    #[test]
    fn set_key_adds_a_provider_key_and_the_file_reopens_with_the_same_password() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "temp").unwrap();
        let mut script = Script::new(&[
            "set_key",
            "temp",
            "REFLECTION_API_KEY",
            "ref-key-canary",
        ]);
        let opened = run_session(&path, &mut script).unwrap();
        assert_eq!(
            opened.provider_keys.get("REFLECTION_API_KEY").map(String::as_str),
            Some("ref-key-canary")
        );
        // The existing values and the password are untouched.
        assert_eq!(
            opened.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("test-api-key")
        );
        assert_eq!(opened.db_key, "history test key");
        let again = unlock_file(&path, "temp").unwrap();
        assert_eq!(
            again.provider_keys.get("REFLECTION_API_KEY").map(String::as_str),
            Some("ref-key-canary")
        );
    }

    #[test]
    fn set_key_updates_a_value_and_removes_a_provider_key_with_an_empty_one() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "temp").unwrap();
        let mut script = Script::new(&["set_key", "temp", "XAI_API_KEY", "rotated-key"]);
        let opened = run_session(&path, &mut script).unwrap();
        assert_eq!(
            opened.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("rotated-key")
        );
        // Remove: an empty value clears a provider key.
        let mut script = Script::new(&["set_key", "temp", "XAI_API_KEY", ""]);
        let cleared = run_session(&path, &mut script).unwrap();
        assert_eq!(cleared.provider_keys.get("XAI_API_KEY"), None);
        assert_eq!(cleared.db_key, "history test key");
    }

    #[test]
    fn set_key_refuses_unknown_names_and_unstorable_values() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "temp").unwrap();
        // Unknown name: warned, then the same flow accepts the real one.
        let mut script = Script::new(&["set_key", "temp", "NOT_A_SECRET", "REFLECTION_API_KEY", "val"]);
        let opened = run_session(&path, &mut script).unwrap();
        assert_eq!(
            opened.provider_keys.get("REFLECTION_API_KEY").map(String::as_str),
            Some("val")
        );
        // A value with a quote cannot be stored; the file is unchanged.
        let mut script = Script::new(&["set_key", "temp", "REFLECTION_API_KEY", "with'quote"]);
        assert!(run_session(&path, &mut script).is_err());
        let untouched = unlock_file(&path, "temp").unwrap();
        assert_eq!(
            untouched.provider_keys.get("REFLECTION_API_KEY").map(String::as_str),
            Some("val")
        );
    }

    #[test]
    fn set_key_guards_the_history_passphrase() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "temp").unwrap();
        // It cannot be removed.
        let mut script = Script::new(&["set_key", "temp", "HARNESS_DB_KEY", ""]);
        assert!(run_session(&path, &mut script).is_err());
        // A short replacement is refused by the passphrase rules.
        let mut script = Script::new(&["set_key", "temp", "HARNESS_DB_KEY", "short"]);
        assert!(run_session(&path, &mut script).is_err());
        // A valid replacement lands and the file reopens with it.
        let mut script = Script::new(&["set_key", "temp", "HARNESS_DB_KEY", "a replacement history passphrase"]);
        let opened = run_session(&path, &mut script).unwrap();
        assert_eq!(opened.db_key, "a replacement history passphrase");
    }

    #[test]
    fn change_password_asks_for_the_current_password_and_the_new_one_twice() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "temp").unwrap();
        let mut script = Script::new(&["change_password", "temp", "aaa", "aaa"]);
        let opened = run_session(&path, &mut script).unwrap();
        assert_eq!(opened.db_key, "history test key");
        assert!(unlock_file(&path, "temp").is_err());
        let with_new = unlock_file(&path, "aaa").unwrap();
        assert_eq!(
            with_new.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("test-api-key")
        );
        let stored = std::fs::read(&path).unwrap();
        assert!(stored.starts_with(AGE_HEADER));
        assert!(
            !stored
                .windows(b"test-api-key".len())
                .any(|window| window == b"test-api-key")
        );
        assert!(
            !stored
                .windows(b"history test key".len())
                .any(|window| window == b"history test key")
        );
    }

    #[test]
    fn a_mismatched_confirmation_leaves_the_old_password() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "temp").unwrap();
        let mut script = Script::new(&[
            "change_password",
            "temp",
            "aaa",
            "bbb",
            "aaa",
            "aa",
            "one",
            "two",
        ]);
        let error = run_session(&path, &mut script).unwrap_err();
        assert!(error.contains("not changed"), "{error}");
        assert!(unlock_file(&path, "temp").is_ok());
        assert!(unlock_file(&path, "aaa").is_err());
    }

    #[test]
    fn the_password_opens_the_file_without_changing_it() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "aaa").unwrap();
        let mut script = Script::new(&["aaa"]);
        let opened = run_session(&path, &mut script).unwrap();
        assert_eq!(
            opened.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("test-api-key")
        );
        assert!(unlock_file(&path, "aaa").is_ok());
    }

    #[test]
    fn help_prints_the_menu_without_consuming_a_login_attempt() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "temp").unwrap();
        // Any number of menus, then the password opens on a full budget.
        let mut script = Script::new(&["help", "help", "help", "temp"]);
        let opened = run_session(&path, &mut script).unwrap();
        assert_eq!(opened.db_key, "history test key");
        // The budget still counts only real tries: menus never rescue a
        // password, and three wrong ones end the session.
        let mut script = Script::new(&[
            "help", "wrong", "help", "wrong", "help", "wrong", "help", "anything",
        ]);
        let refused = run_session(&path, &mut script).unwrap_err();
        assert!(refused.contains("did not open"), "{refused}");
    }

    #[test]
    fn reserved_prompt_words_cannot_become_the_password() {
        // change_password, set_key, set_unreg_keys, and help all mean a
        // command at the prompt: chosen as a password, the command would
        // always win and the real password would become unreachable.
        for word in RESERVED_PROMPT_WORDS {
            let error = check_new_password(word).unwrap_err();
            assert!(error.contains("reserved"), "{word}: {error}");
        }
        assert!(check_new_password("temp").is_ok());
    }

    #[test]
    fn onboarding_yes_creates_an_encrypted_file_with_the_offered_and_skipped_keys() {
        // The wizard imports from the real process environment, so clear
        // the three names first: the test then sees the generated and
        // offered path on any machine, whatever the launching shell had
        // exported. SAFETY: tests only; no other test reads these names
        // (the history test build uses its fixed fallback passphrase).
        for name in ["XAI_API_KEY", "REFLECTION_API_KEY", "HARNESS_DB_KEY"] {
            unsafe { std::env::remove_var(name) };
        }
        let temp = TempKeys::new();
        let path = temp.path();
        // y, password, confirm, XAI value, REFLECTION skipped.
        let mut script = Script::new(&["y", "temp", "temp", "xai-canary", ""]);
        let onboarded = match prompt_onboarding(&path, &mut script).unwrap() {
            Onboarding::Encrypt(secrets) => secrets,
            other => panic!("expected encryption, got {other:?}"),
        };
        assert_eq!(
            onboarded.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("xai-canary")
        );
        assert!(
            !onboarded.provider_keys.contains_key("REFLECTION_API_KEY"),
            "an empty answer skips the slot"
        );
        // The history passphrase was generated: 64 hex characters.
        assert_eq!(onboarded.db_key.len(), 64, "{}", onboarded.db_key);
        assert!(onboarded.db_key.chars().all(|ch| ch.is_ascii_hexdigit()));
        // The file exists, is encrypted, never shows the value on disk,
        // and reopens under the chosen password with the same secrets.
        let stored = std::fs::read(&path).unwrap();
        assert!(stored.starts_with(AGE_HEADER));
        assert!(
            !stored
                .windows(b"xai-canary".len())
                .any(|window| window == b"xai-canary")
        );
        let reopened = unlock_file(&path, "temp").unwrap();
        assert_eq!(
            reopened.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("xai-canary")
        );
        assert_eq!(reopened.db_key, onboarded.db_key);
    }

    #[test]
    fn onboarding_no_is_remembered_but_an_unanswerable_terminal_is_not() {
        let temp = TempKeys::new();
        let path = temp.path();
        // A plain no is remembered (the caller writes the marker).
        let mut script = Script::new(&["n"]);
        match prompt_onboarding(&path, &mut script).unwrap() {
            Onboarding::Decline { remember: true } => {}
            other => panic!("a plain no is remembered, got {other:?}"),
        }
        assert!(
            !declined_marker_path(&path).exists(),
            "the caller writes the marker, not the prompt"
        );
        // Garbage burns the bounded budget and starts plain WITHOUT
        // remembering: a broken terminal must not decide permanently.
        let mut script = Script::new(&["maybe", "huh", "?"]);
        match prompt_onboarding(&path, &mut script).unwrap() {
            Onboarding::Decline { remember: false } => {}
            other => panic!("unanswered prompts are not remembered, got {other:?}"),
        }
        // The marker itself is plain, dated, and deletion re-asks.
        let marker = declined_marker_path(&path);
        write_declined_marker(&marker);
        assert!(marker.is_file());
        let text = std::fs::read_to_string(&marker).unwrap();
        assert!(text.starts_with("declined "), "{text}");
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn set_unreg_keys_offers_only_the_unset_slots_and_reencrypts() {
        let temp = TempKeys::new();
        let path = temp.path();
        write_sample(&path);
        seal_plaintext(&path, "temp").unwrap();
        // The sample carries XAI only, so exactly one offer appears: the
        // hidden value lands and the file reopens with it.
        let mut script = Script::new(&["set_unreg_keys", "temp", "ref-key"]);
        let opened = run_session(&path, &mut script).unwrap();
        assert_eq!(
            opened.provider_keys.get("REFLECTION_API_KEY").map(String::as_str),
            Some("ref-key")
        );
        assert_eq!(
            opened.provider_keys.get("XAI_API_KEY").map(String::as_str),
            Some("test-api-key")
        );
        let again = unlock_file(&path, "temp").unwrap();
        assert_eq!(
            again.provider_keys.get("REFLECTION_API_KEY").map(String::as_str),
            Some("ref-key")
        );
        // Everything already set: no offers, no re-encrypt, and the
        // session still continues into the harness.
        let mut script = Script::new(&["set_unreg_keys", "temp"]);
        let untouched = run_session(&path, &mut script).unwrap();
        assert_eq!(untouched.provider_keys.len(), 2);
    }

    #[test]
    fn the_startup_mode_follows_the_source_of_the_keys() {
        // The keys file always carries a history passphrase.
        assert_eq!(classify_startup(true, Some("k")), StartupMode::Encrypted);
        assert_eq!(classify_startup(true, None), StartupMode::Encrypted);
        // The environment, with and without a history passphrase.
        assert_eq!(classify_startup(false, Some("k")), StartupMode::EnvImported);
        assert_eq!(classify_startup(false, None), StartupMode::PlainSession);
    }

    #[test]
    fn generated_passphrases_are_long_hex_and_never_repeat() {
        // Onboarding stores one in the encrypted file; a plain start uses
        // one for its session-only history. Both must be unguessable and
        // unique per draw.
        let first = generate_passphrase().expect("urandom");
        let second = generate_passphrase().expect("urandom");
        assert_eq!(first.len(), 64, "{first}");
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()), "{first}");
        assert_ne!(first, second, "two draws must differ");
    }

    #[test]
    fn a_symlink_is_refused() {
        let temp = TempKeys::new();
        let real = temp.dir.join("real-keys");
        write_sample(&real);
        let link = temp.path();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let error = seal_plaintext(&link, "temp").unwrap_err();
        assert!(error.contains("symlink"), "{error}");
        let stored = std::fs::read_to_string(&real).unwrap();
        assert!(stored.contains("test-api-key"));
    }

    #[test]
    fn an_age_0_11_scrypt_file_still_opens() {
        // age 0.11.5, scrypt log_n 10, password "temp", plaintext
        // b"age-0.11.5-scrypt". The work factor lives in the header.
        let hex = "\
6167652d656e6372797074696f6e2e6f72672f76310a2d3e2073637279707420634976346e\
7148324349436e6c54753564335a3447512031300a34557971762b5649354864414a646141\
7656464b39435173786d325a78774f5a747054376f464535666b770a2d2d2d202b56617645\
5a45686c68706f626e6d39493877545867337454547a6d565a2f6d336d312f63564a676e48\
410a08839c9784f5eff49142558d11ef1b90a930b73937d6ecc06f65f87567966fc1de733c\
0a6deb2849709c6357252cb1b37b";
        let ciphertext = decode_hex(hex);
        let opened = decrypt_bytes("temp", &ciphertext).unwrap();
        assert_eq!(opened, b"age-0.11.5-scrypt");
        assert!(decrypt_bytes("aaa", &ciphertext).is_err());
    }

    fn decode_hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
            .collect()
    }
}
