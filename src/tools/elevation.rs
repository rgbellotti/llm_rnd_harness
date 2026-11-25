//! Detection of elevation words (`sudo`, `su`, `pkexec`, `doas`) in a
//! proposed shell command.
//!
//! `run_cmd` runs as the invoking user, so a command that would escalate
//! is flagged in the approval dialog and the model is told to use
//! `run_sudo_cmd_relay` instead. This detector is that speed bump. It is
//! deliberately conservative: it catches the common shapes (paths, `env`,
//! wrappers, `sh -c`, `python -c`, simple variable expansions) and stays
//! quiet when it cannot tell, because the real control is the approval
//! dialog — every command is shown in full before anything runs.
//!
//! The `--sudo-reaper` / `--sudo-supervisor` argv checks remain even though
//! the retired askpass supervisor no longer exists: those words in a
//! command still literally announce sudo intent against this binary, and
//! an older build of the harness would still act on them.

/// Command word that would start sudo, su, pkexec, or doas.
/// A speed bump: quotes, `env`, paths, shell separators, leading redirects,
/// wrappers (`exec`, `eval`, `setsid`, `flock`, `stdbuf`, `command -p`),
/// simple `name=sudo` expansions, ANSI-C `$'...'`, `sh -c`, and `python -c`
/// are handled. Nested indirection and opaque binaries are not.
pub(crate) fn elevation_token(command: &str) -> Option<&'static str> {
    elevation_token_depth(command, 0)
}

fn elevation_token_depth(command: &str, depth: usize) -> Option<&'static str> {
    if depth > 4 {
        return None;
    }
    let bytes = command.as_bytes();
    let mut index = 0;
    let mut command_pos = true;
    // Inside `$(...)` or backticks, an elevation word is enough. `$(echo sudo)`
    // does not put sudo in command position, and executing the substitution
    // to find out is not this check's job.
    let mut loose = 0i32;
    let mut bound: Vec<(String, &'static str)> = Vec::new();
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'\n' || byte == b';' {
            command_pos = true;
            index += 1;
            continue;
        }
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if byte == b'|' {
            command_pos = true;
            index += 1;
            if index < bytes.len() && bytes[index] == b'|' {
                index += 1;
            }
            continue;
        }
        if byte == b'&' {
            command_pos = true;
            index += 1;
            if index < bytes.len() && bytes[index] == b'&' {
                index += 1;
            }
            continue;
        }
        if byte == b')' && loose > 0 {
            loose -= 1;
            command_pos = true;
            index += 1;
            continue;
        }
        if byte == b'`' {
            loose = if loose > 0 { loose - 1 } else { loose + 1 };
            command_pos = true;
            index += 1;
            continue;
        }
        if matches!(byte, b'(' | b'{' | b'}') {
            command_pos = true;
            index += 1;
            continue;
        }
        if byte == b'$' && index + 1 < bytes.len() && bytes[index + 1] == b'(' {
            loose += 1;
            command_pos = true;
            index += 2;
            continue;
        }
        if byte == b'#' && command_pos && loose == 0 {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if command_pos && redirect_at(bytes, index) {
            index = skip_redirect(bytes, index);
            continue;
        }
        let (word, next) = read_shell_word(bytes, index);
        if word.is_empty() {
            index = next.max(index + 1);
            continue;
        }
        if word == "--sudo-reaper" || word == "--sudo-supervisor" {
            return Some("sudo");
        }
        if !command_pos && loose == 0 {
            index = next;
            continue;
        }
        if let Some(token) = bound_expansion(&word, &bound) {
            return Some(token);
        }
        if is_assignment(&word) {
            record_assignment(&word, &mut bound);
            index = next;
            continue;
        }
        if word == "env" {
            index = skip_env_prefix(bytes, next);
            continue;
        }
        if word == "command" {
            index = skip_command_options(bytes, next);
            continue;
        }
        if word == "flock" {
            if let Some(token) = flock_command(bytes, next, depth) {
                return Some(token);
            }
            command_pos = false;
            index = next;
            continue;
        }
        if word == "stdbuf" {
            index = skip_stdbuf_options(bytes, next);
            continue;
        }
        if matches!(word.as_str(), "nohup" | "nice" | "time" | "exec" | "setsid" | "eval") {
            if word == "eval" {
                let (code, after) = read_shell_word(bytes, skip_space(bytes, next));
                if let Some(token) = elevation_token_depth(&code, depth + 1) {
                    return Some(token);
                }
                index = after;
                continue;
            }
            index = if word == "setsid" {
                skip_leading_options(bytes, next)
            } else {
                next
            };
            continue;
        }
        if is_script_interpreter(&word) {
            if let Some((script, after)) = exact_c_argument(bytes, next) {
                if let Some(token) = contains_elevation_word(&script)
                    .or_else(|| elevation_token_depth(&script, depth + 1))
                {
                    return Some(token);
                }
                index = after;
            } else {
                index = next;
            }
            command_pos = false;
            continue;
        }
        if is_shell_name(&word) {
            if let Some((script, after)) = shell_c_argument(bytes, next) {
                if let Some(token) = scan_script(&script, depth) {
                    return Some(token);
                }
                index = after;
            } else {
                index = next;
            }
            command_pos = false;
            continue;
        }
        if let Some(token) = elevation_basename(&word) {
            return Some(token);
        }
        command_pos = false;
        index = next;
    }
    None
}

fn scan_script(script: &str, depth: usize) -> Option<&'static str> {
    elevation_token_depth(script, depth + 1).or_else(|| loose_elevation_word(script))
}

/// An elevation basename anywhere in an interpreter `-c` string.
fn contains_elevation_word(text: &str) -> Option<&'static str> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if text[index..].starts_with("--sudo-reaper") || text[index..].starts_with("--sudo-supervisor")
        {
            let len = if text[index..].starts_with("--sudo-reaper") {
                "--sudo-reaper".len()
            } else {
                "--sudo-supervisor".len()
            };
            let after = index + len;
            if after == bytes.len() || !is_ident_byte(bytes[after]) {
                return Some("sudo");
            }
        }
        for (name, token) in [("sudo", "sudo"), ("pkexec", "pkexec"), ("doas", "doas"), ("su", "su")] {
            if text[index..].starts_with(name) {
                let before_ok = index == 0 || !is_ident_byte(bytes[index - 1]);
                let after = index + name.len();
                let after_ok = after == bytes.len() || !is_ident_byte(bytes[after]);
                if before_ok && after_ok {
                    return Some(token);
                }
            }
        }
        index += 1;
    }
    None
}

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'/'
}

/// Any elevation basename in the text, not only in command position.
fn loose_elevation_word(script: &str) -> Option<&'static str> {
    let bytes = script.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace()
            || matches!(bytes[index], b';' | b'|' | b'&' | b'(' | b')' | b'`' | b'{' | b'}')
        {
            index += 1;
            continue;
        }
        let (word, next) = read_shell_word(bytes, index);
        if let Some(token) = elevation_basename(&word) {
            return Some(token);
        }
        if word == "--sudo-reaper" || word == "--sudo-supervisor" {
            return Some("sudo");
        }
        index = next.max(index + 1);
    }
    None
}

fn record_assignment(word: &str, bound: &mut Vec<(String, &'static str)>) {
    let Some((name, value)) = word.split_once('=') else {
        return;
    };
    bound.retain(|(existing, _)| existing != name);
    if let Some(token) = elevation_basename(value) {
        bound.push((name.to_string(), token));
    }
}

fn bound_expansion(word: &str, bound: &[(String, &'static str)]) -> Option<&'static str> {
    let name = word.strip_prefix('$')?;
    let name = name
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .unwrap_or(name);
    if name.is_empty() || !name.chars().all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
        return None;
    }
    bound
        .iter()
        .rev()
        .find(|(existing, _)| existing == name)
        .map(|(_, token)| *token)
}

fn is_script_interpreter(word: &str) -> bool {
    matches!(
        word.rsplit('/').next().unwrap_or(word),
        "python" | "python2" | "python3" | "perl" | "ruby" | "node" | "nodejs"
    )
}

fn skip_command_options(bytes: &[u8], mut index: usize) -> usize {
    loop {
        index = skip_space(bytes, index);
        if index >= bytes.len() || command_break(bytes[index]) {
            return index;
        }
        let (word, next) = read_shell_word(bytes, index);
        if matches!(word.as_str(), "-p" | "-v" | "-V" | "--") || word.starts_with('-') {
            index = next;
            continue;
        }
        return index;
    }
}

fn skip_stdbuf_options(bytes: &[u8], mut index: usize) -> usize {
    loop {
        index = skip_space(bytes, index);
        if index >= bytes.len() || command_break(bytes[index]) {
            return index;
        }
        let (word, next) = read_shell_word(bytes, index);
        if word == "-i" || word == "-o" || word == "-e" {
            index = skip_one_word(bytes, next);
            continue;
        }
        if word.starts_with('-') {
            index = next;
            continue;
        }
        return index;
    }
}

fn flock_command(bytes: &[u8], mut index: usize, depth: usize) -> Option<&'static str> {
    loop {
        index = skip_space(bytes, index);
        if index >= bytes.len() || command_break(bytes[index]) {
            return None;
        }
        let (word, next) = read_shell_word(bytes, index);
        if matches!(word.as_str(), "-w" | "--timeout" | "-E" | "--conflict-exit-code") {
            index = skip_one_word(bytes, next);
            continue;
        }
        if word == "--" {
            index = next;
            break;
        }
        if word.starts_with('-') && word != "-c" {
            index = next;
            continue;
        }
        break;
    }
    index = skip_space(bytes, index);
    let (operand, after_operand) = read_shell_word(bytes, index);
    if operand.is_empty() {
        return None;
    }
    if operand == "-c" {
        let (script, _) = read_shell_word(bytes, skip_space(bytes, after_operand));
        return scan_script(&script, depth);
    }
    // The operand is the lock path. The next word is the command.
    let (command, _) = read_shell_word(bytes, skip_space(bytes, after_operand));
    if command == "-c" {
        let after = skip_one_word(bytes, skip_space(bytes, after_operand));
        let (script, _) = read_shell_word(bytes, skip_space(bytes, after));
        return scan_script(&script, depth);
    }
    elevation_basename(&command).or_else(|| elevation_token_depth(&command, depth + 1))
}

fn exact_c_argument(bytes: &[u8], mut index: usize) -> Option<(String, usize)> {
    loop {
        index = skip_space(bytes, index);
        if index >= bytes.len() || command_break(bytes[index]) {
            return None;
        }
        let (word, next) = read_shell_word(bytes, index);
        if word == "-c" {
            let (script, after) = read_shell_word(bytes, skip_space(bytes, next));
            if script.is_empty() {
                return None;
            }
            return Some((script, after));
        }
        if word.starts_with('-') {
            index = next;
            continue;
        }
        return None;
    }
}

fn skip_leading_options(bytes: &[u8], mut index: usize) -> usize {
    loop {
        index = skip_space(bytes, index);
        if index >= bytes.len() || command_break(bytes[index]) {
            return index;
        }
        let (word, next) = read_shell_word(bytes, index);
        if word.starts_with('-') && word != "-" {
            index = next;
            continue;
        }
        return index;
    }
}

fn command_break(byte: u8) -> bool {
    matches!(byte, b';' | b'|' | b'&' | b'\n')
}

fn skip_one_word(bytes: &[u8], index: usize) -> usize {
    let index = skip_space(bytes, index);
    if index >= bytes.len() || command_break(bytes[index]) {
        return index;
    }
    let (_word, next) = read_shell_word(bytes, index);
    next
}

fn is_shell_name(word: &str) -> bool {
    matches!(
        word.rsplit('/').next().unwrap_or(word),
        "sh" | "bash" | "zsh" | "dash"
    )
}

/// The string after `sh -c` / `bash -lc`, if this invocation has one.
fn shell_c_argument(bytes: &[u8], mut index: usize) -> Option<(String, usize)> {
    loop {
        index = skip_space(bytes, index);
        if index >= bytes.len() || matches!(bytes[index], b';' | b'|' | b'&' | b'\n') {
            return None;
        }
        let (word, next) = read_shell_word(bytes, index);
        if word == "-c" || (word.starts_with('-') && !word.starts_with("--") && word.contains('c'))
        {
            let (script, after) = read_shell_word(bytes, skip_space(bytes, next));
            if script.is_empty() {
                return None;
            }
            return Some((script, after));
        }
        if word.starts_with('-') {
            index = next;
            continue;
        }
        return None;
    }
}

fn redirect_at(bytes: &[u8], mut index: usize) -> bool {
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    matches!(bytes.get(index), Some(b'<' | b'>'))
}

fn skip_redirect(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index < bytes.len() && matches!(bytes[index], b'<' | b'>') {
        index += 1;
        if index < bytes.len() && matches!(bytes[index], b'<' | b'>' | b'&' | b'|') {
            index += 1;
        }
    }
    index = skip_space(bytes, index);
    if index < bytes.len() && !matches!(bytes[index], b';' | b'|' | b'&' | b'\n' | b'#' ) {
        let (_word, next) = read_shell_word(bytes, index);
        index = next;
    }
    index
}

fn elevation_basename(word: &str) -> Option<&'static str> {
    let base = word.rsplit('/').next().unwrap_or(word);
    match base {
        "sudo" => Some("sudo"),
        "su" => Some("su"),
        "pkexec" => Some("pkexec"),
        "doas" => Some("doas"),
        _ => None,
    }
}

fn is_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn read_shell_word(bytes: &[u8], mut index: usize) -> (String, usize) {
    let mut out = String::new();
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace()
            || matches!(
                byte,
                b';' | b'|' | b'&' | b'(' | b')' | b'`' | b'{' | b'}' | b'<' | b'>' | b'#'
            )
        {
            break;
        }
        if byte == b'$' && index + 1 < bytes.len() && bytes[index + 1] == b'(' {
            break;
        }
        if byte == b'\'' {
            index += 1;
            while index < bytes.len() && bytes[index] != b'\'' {
                out.push(bytes[index] as char);
                index += 1;
            }
            if index < bytes.len() {
                index += 1;
            }
            continue;
        }
        if byte == b'"' {
            index += 1;
            while index < bytes.len() && bytes[index] != b'"' {
                if bytes[index] == b'\\' && index + 1 < bytes.len() {
                    index += 1;
                }
                out.push(bytes[index] as char);
                index += 1;
            }
            if index < bytes.len() {
                index += 1;
            }
            continue;
        }
        if byte == b'$' && index + 1 < bytes.len() && bytes[index + 1] == b'\'' {
            index += 2;
            index = push_ansi_c(bytes, index, &mut out);
            continue;
        }
        if byte == b'\\' && index + 1 < bytes.len() {
            index += 1;
            out.push(bytes[index] as char);
            index += 1;
            continue;
        }
        out.push(byte as char);
        index += 1;
    }
    (out, index)
}

/// Decode `$'...'` up to the closing quote. Returns the index after it.
fn push_ansi_c(bytes: &[u8], mut index: usize, out: &mut String) -> usize {
    while index < bytes.len() && bytes[index] != b'\'' {
        if bytes[index] == b'\\' && index + 1 < bytes.len() {
            index += 1;
            match bytes[index] {
                b'n' => out.push('\n'),
                b't' => out.push('\t'),
                b'r' => out.push('\r'),
                b'\\' => out.push('\\'),
                b'\'' => out.push('\''),
                b'x' => {
                    index += 1;
                    let mut value = 0u8;
                    let mut digits = 0;
                    while digits < 2 && index < bytes.len() && bytes[index].is_ascii_hexdigit() {
                        value = value * 16 + (bytes[index] as char).to_digit(16).unwrap_or(0) as u8;
                        index += 1;
                        digits += 1;
                    }
                    if digits > 0 {
                        out.push(value as char);
                        continue;
                    }
                }
                other => out.push(other as char),
            }
            index += 1;
            continue;
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    if index < bytes.len() && bytes[index] == b'\'' {
        index += 1;
    }
    index
}

fn skip_env_prefix(bytes: &[u8], mut index: usize) -> usize {
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() && bytes[index] != b'\n' {
            index += 1;
        }
        if index >= bytes.len() || matches!(bytes[index], b';' | b'|' | b'&' | b'\n' | b'(' | b')')
        {
            return index;
        }
        let (word, next) = read_shell_word(bytes, index);
        if word == "--" {
            return skip_space(bytes, next);
        }
        if word == "-u" || word == "--unset" {
            index = skip_one_word(bytes, next);
            continue;
        }
        if word.starts_with("--unset=")
            || word.starts_with("--chdir=")
            || word.starts_with("--split-string=")
        {
            index = next;
            continue;
        }
        if word.starts_with('-') && word != "-" {
            index = next;
            continue;
        }
        if is_assignment(&word) {
            index = next;
            continue;
        }
        return index;
    }
}

fn skip_space(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() && bytes[index] != b'\n' {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevation_tokens_cover_paths_env_and_chains() {
        assert_eq!(elevation_token("  sudo id"), Some("sudo"));
        assert_eq!(elevation_token("\nsudo id"), Some("sudo"));
        assert_eq!(elevation_token("env sudo id"), Some("sudo"));
        assert_eq!(elevation_token("env -i sudo id"), Some("sudo"));
        assert_eq!(elevation_token("env FOO=bar sudo -n id"), Some("sudo"));
        assert_eq!(elevation_token("env -u PATH sudo id"), Some("sudo"));
        assert_eq!(elevation_token("/usr/bin/sudo id"), Some("sudo"));
        assert_eq!(elevation_token("/bin/sudo -n true"), Some("sudo"));
        assert_eq!(elevation_token("ls && sudo id"), Some("sudo"));
        assert_eq!(elevation_token("ls; sudo id"), Some("sudo"));
        assert_eq!(elevation_token("ls | sudo tee x"), Some("sudo"));
        assert_eq!(elevation_token("(sudo id)"), Some("sudo"));
        assert_eq!(elevation_token("echo $(sudo id)"), Some("sudo"));
        assert_eq!(elevation_token("echo `sudo id`"), Some("sudo"));
        assert_eq!(elevation_token("su -"), Some("su"));
        assert_eq!(elevation_token("pkexec id"), Some("pkexec"));
        assert_eq!(elevation_token("/usr/bin/doas id"), Some("doas"));
        assert_eq!(elevation_token("echo sudo"), None);
        assert_eq!(elevation_token("ls /usr/bin/sudo"), None);
        assert_eq!(elevation_token("grep sudo file"), None);
        assert_eq!(elevation_token("echo \"not sudo\""), None);
        assert_eq!(elevation_token("printf hello"), None);
        assert_eq!(elevation_token(">/tmp/x sudo id"), Some("sudo"));
        assert_eq!(elevation_token("</dev/null sudo id"), Some("sudo"));
        assert_eq!(elevation_token("2>x sudo -n id"), Some("sudo"));
        assert_eq!(elevation_token("exec sudo id"), Some("sudo"));
        assert_eq!(elevation_token("eval sudo id"), Some("sudo"));
        assert_eq!(elevation_token("eval 'sudo id'"), Some("sudo"));
        assert_eq!(elevation_token("$'sudo' id"), Some("sudo"));
        assert_eq!(elevation_token("$'\\x73udo' id"), Some("sudo"));
        assert_eq!(elevation_token("bash -c 'sudo id'"), Some("sudo"));
        assert_eq!(elevation_token("bash -lc 'sudo id'"), Some("sudo"));
        assert_eq!(elevation_token("/bin/sh -c \"pkexec id\""), Some("pkexec"));
        assert_eq!(elevation_token("dash -c 'echo hi'"), None);
        assert_eq!(elevation_token("a=sudo; $a id"), Some("sudo"));
        assert_eq!(elevation_token("a=/usr/bin/sudo; $a -n id"), Some("sudo"));
        assert_eq!(elevation_token("a=sudo; a=ls; $a"), None);
        assert_eq!(
            elevation_token("python3 -c 'import os; os.system(\"sudo id\")'"),
            Some("sudo")
        );
        assert_eq!(elevation_token("python3 -c 'print(1)'"), None);
        assert_eq!(elevation_token("$(echo sudo) id"), Some("sudo"));
        assert_eq!(elevation_token("setsid sudo id"), Some("sudo"));
        assert_eq!(elevation_token("setsid -w sudo -n id"), Some("sudo"));
        assert_eq!(elevation_token("flock /tmp/x sudo id"), Some("sudo"));
        assert_eq!(elevation_token("flock -n /tmp/x sudo -n id"), Some("sudo"));
        assert_eq!(elevation_token("flock /tmp/x -c 'sudo id'"), Some("sudo"));
        assert_eq!(elevation_token("stdbuf -oL sudo id"), Some("sudo"));
        assert_eq!(elevation_token("stdbuf -o L sudo id"), Some("sudo"));
        assert_eq!(elevation_token("command -p sudo id"), Some("sudo"));
        assert_eq!(
            elevation_token("llm_rnd_harness --sudo-reaper -- /usr/bin/sudo -n id"),
            Some("sudo")
        );
        // The substitution contains the word, so this one is caught.
        assert_eq!(elevation_token("a=$(echo sudo); $a id"), Some("sudo"));
        // Still a speed bump: the value is not a literal elevation word.
        assert_eq!(elevation_token("a=$(printf '\\x73udo'); $a id"), None);
        assert_eq!(elevation_token("b=$a; $b id"), None);
    }
}
