//! uv-backed web search and editable page retrieval.
use ollama_rs::generation::tools::ToolInfo;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::SystemTime;

pub const SEARCH: &str = "web_search";
pub const FETCH: &str = "web_fetch";

#[derive(Clone, Debug, Serialize)]
pub(crate) struct WebRequest {
    pub kind: String,
    pub query: Option<String>,
    pub max_results: Option<usize>,
    pub url: Option<String>,
    pub preview: Option<String>,
    /// Human-readable risk notes shown with the approval dialog (empty for
    /// search and for plain fetch URLs). Advisory only: every URL still goes
    /// through the human gate.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<String>,
    /// Capped HTTP document body for a fetch review. The editable preview
    /// stays the rendered DOM text; this is the read-only archive beside it.
    /// Search leaves it empty, and serde omits it then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_body: Option<String>,
    /// Browser stderr for a fetch review: refused subresources and other
    /// page-load notes. The dialog shows this on its own tab. It is not part
    /// of the text submitted to the model. Search leaves it empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
}

impl WebRequest {
    pub fn parse(name: &str, args: &Value) -> Result<Self, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SearchArgs {
            query: String,
            #[serde(default = "default_results")]
            max_results: usize,
        }
        fn default_results() -> usize {
            5
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct FetchArgs {
            url: String,
        }
        match name {
            SEARCH => {
                let a: SearchArgs =
                    serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                if a.query.trim().is_empty() || !(1..=20).contains(&a.max_results) {
                    return Err("provide a non-empty query and max_results from 1 to 20".into());
                }
                Ok(Self {
                    kind: "search".into(),
                    query: Some(a.query),
                    max_results: Some(a.max_results),
                    url: None,
                    preview: None,
                    notices: Vec::new(),
                    raw_body: None,
                    stderr: None,
                })
            }
            FETCH => {
                let a: FetchArgs =
                    serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                if !["http://", "https://"].iter().any(|prefix| {
                    a.url
                        .strip_prefix(prefix)
                        .is_some_and(|tail| !tail.is_empty())
                }) || a.url.chars().any(|c| c.is_whitespace() || c.is_control())
                {
                    return Err(
                        "provide one HTTP(S) url without whitespace or control characters".into(),
                    );
                }
                // Structural safety checks run now so clearly unsafe targets
                // are rejected as tool-argument errors, not silently executed.
                // Network-level checks (DNS) happen again at execution time.
                let notices = check_fetch_url(&a.url)?;
                Ok(Self {
                    kind: "fetch".into(),
                    query: None,
                    max_results: None,
                    url: Some(a.url),
                    preview: None,
                    notices,
                    raw_body: None,
                    stderr: None,
                })
            }
            _ => Err("unknown web tool".into()),
        }
    }

    pub fn result(&self, text: String) -> Result<Value, String> {
        if text.trim().is_empty() {
            return Err(
                "Enter results, page content, or an explicit no-results/retrieval-error report."
                    .into(),
            );
        }
        Ok(if self.kind == "search" {
            json!({"query": self.query, "max_results": self.max_results, "results": text})
        } else {
            json!({"url": self.url, "content": text})
        })
    }
}

// ---------------------------------------------------------------
// Fetch-target safety: loopback/private/credentials rejection.
// The browser (Chromium via Playwright) runs with the user's full
// network access, so a fetch to an internal service is a real SSRF
// channel — these checks refuse the dangerous classes outright.
// --------------------------------------------------------------

/// Advisory-only query-string scan: several secret-ish parameter names in
/// one URL are how prompt-injected payloads walk data out of the machine.
fn url_query_notices(url: &str) -> Vec<String> {
    const SENSITIVE_MARKERS: [&str; 8] = [
        "password=",
        "passwd=",
        "token=",
        "api_key=",
        "api-key=",
        "apikey=",
        "secret=",
        "authorization",
    ];
    let query = url
        .split_once('?')
        .map(|(_, q)| q.split('#').next().unwrap_or(q))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let hits: Vec<&str> = SENSITIVE_MARKERS
        .iter()
        .copied()
        .filter(|marker| query.contains(marker))
        .collect();
    if hits.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "URL query contains sensitive-looking parameters ({}). Verify the URL deliberately before approving — this could carry data out of the machine.",
            hits.join(", ")
        )]
    }
}

/// Authority part of an already-schemed URL (between `://` and the first
/// `/`, `?`, or `#`). None when there is no authority (e.g. bare paths).
fn url_authority(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(&rest[..end])
}

/// Lowercased host and effective port from a validated HTTP(S) URL.
fn url_host_and_port(url: &str) -> Option<(String, u16)> {
    let authority = url_authority(url)?;
    if authority.contains('@') {
        // Credentials are rejected before this runs.
        return None;
    }
    let default_port = if url.starts_with("https://") { 443 } else { 80 };
    let (host, port) = if authority.starts_with('[') {
        // [v6-address] with an optional :port suffix.
        let close = authority.find(']')?;
        let suffix = authority.get(close + 1..).unwrap_or_default();
        let port = if suffix.is_empty() {
            None
        } else {
            let digits = suffix.strip_prefix(':')?;
            Some(digits.parse::<u16>().ok()?)
        };
        (authority[1..close].to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, digits)) => (host.to_string(), digits.parse::<u16>().ok()),
            None => (authority.to_string(), None),
        }
    };
    Some((host.to_ascii_lowercase(), port.unwrap_or(default_port)))
}

/// Reason a parsed IP address may not be fetched. Plain, stdlib-only
/// classification (no `is_global` — that is still unstable).
fn ip_forbidden_reason(ip: &std::net::IpAddr) -> Option<&'static str> {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            if o[0] == 127 {
                Some("loopback (127.0.0.0/8)")
            } else if o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
            {
                Some("private address (RFC 1918)")
            } else if o[0] == 169 && o[1] == 254 {
                Some("link-local address (169.254.0.0/16)")
            } else if o[0] == 100 && (64..=127).contains(&o[1]) {
                // Carrier-grade NAT: hosts cloud metadata endpoints
                // (100.100.100.200) as well as consumer NAT.
                Some("shared address space (100.64.0.0/10)")
            } else if o[0] == 192 && o[1] == 0 && o[2] == 0 {
                Some("IETF protocol assignments (192.0.0.0/24)")
            } else if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
                Some("benchmarking address (198.18.0.0/15)")
            } else if (o[0] == 192 && o[1] == 0 && o[2] == 2)
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)
                || (o[0] == 203 && o[1] == 0 && o[2] == 113)
            {
                Some("documentation address")
            } else if o == [0, 0, 0, 0] {
                Some("unspecified address (0.0.0.0)")
            } else if o[0] >= 224 {
                Some("multicast/reserved address")
            } else {
                None
            }
        }
        std::net::IpAddr::V6(v6) => {
            // IPv4-mapped addresses (::ffff:127.0.0.1) are loopback in
            // every way that matters to the OS. The Python policy already
            // maps them; the Rust pre-check must agree.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return ip_forbidden_reason(&std::net::IpAddr::V4(mapped));
            }
            let s = v6.segments();
            if v6.is_loopback() {
                Some("loopback (::1)")
            } else if (s[0] & 0xffc0) == 0xfe80 {
                Some("link-local address (fe80::/10)")
            } else if (s[0] & 0xfe00) == 0xfc00 {
                Some("private address (fc00::/7 unique-local)")
            } else if (s[0] & 0xffc0) == 0xfec0 {
                Some("site-local address (fec0::/10)")
            } else if (s[0] & 0xff00) == 0xff00 {
                Some("multicast address")
            } else if s[0] == 0x2002 {
                // 6to4 embeds an IPv4 address in bits 16..47. A 6to4
                // route for a private IPv4 address must be refused too.
                let v4 = std::net::Ipv4Addr::new(
                    (s[1] >> 8) as u8,
                    s[1] as u8,
                    (s[2] >> 8) as u8,
                    s[2] as u8,
                );
                if let Some(reason) = ip_forbidden_reason(&std::net::IpAddr::V4(v4)) {
                    return Some(reason);
                }
                None
            } else if s[0] == 0x0064
                && s[1] == 0xff9b
                && s[2] == 0
                && s[3] == 0
                && s[4] == 0
                && s[5] == 0
            {
                // NAT64 well-known prefix embeds the final IPv4 address.
                let v4 = std::net::Ipv4Addr::new(
                    (s[6] >> 8) as u8,
                    s[6] as u8,
                    (s[7] >> 8) as u8,
                    s[7] as u8,
                );
                if let Some(reason) = ip_forbidden_reason(&std::net::IpAddr::V4(v4)) {
                    return Some(reason);
                }
                None
            } else if s.iter().all(|&seg| seg == 0) && v6.to_string() == "::" {
                Some("unspecified address (::)")
            } else {
                None
            }
        }
    }
}

/// Reason a hostname string itself identifies a local/internal target.
/// Numeric hostnames (Chromium treats `2130706433` as 127.0.0.1) fall
/// through to the DNS check at execution time, where getaddrinfo resolves
/// them to the loopback address and the IP check catches them.
fn hostname_forbidden_reason(host: &str) -> Option<&'static str> {
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower.ends_with(".home.arpa")
        || lower.ends_with(".lan")
        || lower.ends_with(".home")
        || lower.ends_with(".corp")
        || lower.ends_with(".localdomain")
    {
        Some("local/internal hostname")
    } else {
        None
    }
}

/// Synchronous fetch-URL checks: scheme reaffirmed, no embedded
/// credentials, no IP-literal or name-based local target. Returns
/// advisory notices (not refusals) for sensitive-looking query strings.
/// The executes-time DNS resolution rejects hostnames that *resolve*
/// into private space; call [`check_fetch_target`] for that.
pub(crate) fn check_fetch_url(url: &str) -> Result<Vec<String>, String> {
    let _authority = url_authority(url)
        .ok_or_else(|| "provide one HTTP(S) url with an authority".to_string())?;
    if _authority.contains('@') {
        return Err("URLs with embedded credentials (user:password@host) are not allowed".into());
    }
    let (host, _port) = url_host_and_port(url)
        .ok_or_else(|| "provide one HTTP(S) url with a hostname".to_string())?;
    if host.is_empty() {
        return Err("provide one HTTP(S) url with a hostname".into());
    }
    let forbidden = {
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            ip_forbidden_reason(&ip)
        } else {
            hostname_forbidden_reason(&host)
        }
    };
    if let Some(reason) = forbidden {
        return Err(format!(
            "refusing to fetch {host}: target is a {reason}. \
             Private and loopback targets are not available through this harness."
        ));
    }
    Ok(url_query_notices(url))
}

/// Full check including DNS: a hostname that resolves into loopback or
/// private space is refused too (fail-closed; if DNS itself fails the
/// fetch would not work anyway).
pub(crate) async fn check_fetch_target(url: &str) -> Result<Vec<String>, String> {
    let notices = check_fetch_url(url)?;
    let (host, port) = url_host_and_port(url)
        .ok_or_else(|| "provide one HTTP(S) url with a hostname".to_string())?;
    if host.parse::<std::net::IpAddr>().is_err() && !hostname_forbidden_reason(&host).is_some() {
        let addrs = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|e| format!("could not resolve host {host:?}: {e}"))?;
        for addr in addrs {
            if let Some(reason) = ip_forbidden_reason(&addr.ip()) {
                return Err(format!(
                    "refusing to fetch {host}: it resolves to a {reason}. \
                     Private and loopback targets are not available through this harness."
                ));
            }
        }
    }
    Ok(notices)
}
#[derive(Debug, Serialize)]
pub(crate) struct Execution {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// Capped HTTP body of a fetched document, split out of web-tool stderr.
    /// Search, PDF, and RAG leave this empty. Omitted from the preview JSON
    /// when absent so those archives stay the same shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_body: Option<String>,
}

/// Marker the fetch tool prints around the document body on stderr.
const RAW_BODY_PREFIX: &str = "---HARNESS_RAW_BODY ";
const RAW_BODY_HEADER_END: &str = "---\n";
const RAW_BODY_FOOTER: &str = "\n---HARNESS_RAW_BODY_END---";

/// Pull the capped document body out of web-tool stderr.
///
/// The block is length-prefixed so a page that contains the footer text
/// is still one slice. Other stderr (refused-request notes) stays stderr.
/// A missing or unfinished header leaves stderr unchanged.
fn split_raw_body(stderr: &str) -> (String, Option<String>) {
    let Some(start) = stderr.find(RAW_BODY_PREFIX) else {
        return (stderr.to_string(), None);
    };
    let header_at = start + RAW_BODY_PREFIX.len();
    let Some(header_rel) = stderr[header_at..].find(RAW_BODY_HEADER_END) else {
        return (stderr.to_string(), None);
    };
    let header = &stderr[header_at..header_at + header_rel];
    let Some(bytes) = header.split_whitespace().find_map(|part| {
        part.strip_prefix("bytes=")
            .and_then(|value| value.parse::<usize>().ok())
    }) else {
        return (stderr.to_string(), None);
    };
    let body_start = header_at + header_rel + RAW_BODY_HEADER_END.len();
    if body_start > stderr.len() || !stderr.is_char_boundary(body_start) {
        return (stderr.to_string(), None);
    }
    let mut body_end = body_start + bytes.min(stderr.len() - body_start);
    while body_end > body_start && !stderr.is_char_boundary(body_end) {
        body_end -= 1;
    }
    let raw = stderr[body_start..body_end].to_string();
    let mut block_end = body_end;
    if stderr[block_end..].starts_with(RAW_BODY_FOOTER) {
        block_end += RAW_BODY_FOOTER.len();
        if stderr[block_end..].starts_with('\n') {
            block_end += 1;
        }
    }
    let mut cleaned = String::new();
    cleaned.push_str(&stderr[..start]);
    cleaned.push_str(&stderr[block_end..]);
    (cleaned, Some(raw))
}
impl Execution {
    /// Text the search review opens on. A capture that already has stdout
    /// is that text: a non-zero exit must not claim the tool returned
    /// nothing. Stderr is included only when the process did not exit 0
    /// and there is something to show. Fetch uses `fetch_page_text` instead.
    pub fn review_text(&self) -> String {
        if !self.stdout.trim().is_empty() {
            if self.exit_code == Some(0) || self.stderr.trim().is_empty() {
                return self.stdout.clone();
            }
            return format!("{}\nstderr:\n{}", self.stdout, self.stderr);
        }
        let note = if self.exit_code == Some(0) {
            "Web tool returned no content."
        } else {
            "Web tool retrieval failed."
        };
        if self.stderr.trim().is_empty() {
            return note.to_string();
        }
        format!(
            "{note}\nstderr:\n{}\nexit code: {:?}",
            self.stderr, self.exit_code
        )
    }

    /// Page text for a fetch review. Stderr stays off this string so a
    /// refused subresource does not enter the text the model can receive.
    /// Search still uses `review_text`, which keeps stderr on failure.
    pub fn fetch_page_text(&self) -> String {
        if !self.stdout.trim().is_empty() {
            self.stdout.clone()
        } else {
            "Web fetch returned no page text.".to_string()
        }
    }
}

impl WebRequest {
    pub fn argv(&self) -> Vec<String> {
        if self.kind == "search" {
            vec![
                "search".into(),
                self.query.clone().unwrap(),
                self.max_results.unwrap().to_string(),
            ]
        } else {
            vec!["fetch".into(), self.url.clone().unwrap()]
        }
    }
    pub async fn execute(&self, program: &std::path::Path) -> Execution {
        if !integrity_ok() {
            return Execution {
                stdout: String::new(),
                stderr: "Web tool files are not the ones this harness registered — refusing to run. \
                         Restart the harness after installing or updating the web tool."
                    .to_string(),
                exit_code: None,
                duration_ms: 0,
                raw_body: None,
            };
        }
        // Recheck at execution time: a hostname can resolve into private
        // space even when its literal form is public, and numeric host
        // forms (e.g. `2130706433`) get resolved by getaddrinfo here.
        if self.kind == "fetch" {
            let url = self.url.clone().unwrap_or_default();
            if let Err(reason) = check_fetch_target(&url).await {
                return Execution {
                    stdout: String::new(),
                    stderr: format!("Fetch refused before execution: {reason}"),
                    exit_code: None,
                    duration_ms: 0,
                    raw_body: None,
                };
            }
        }
        execute_command(
            program,
            &crate::config::WORKSPACE_DIR.join("web_tool"),
            &self.argv(),
        )
        .await
    }
}

async fn execute_command(
    program: &std::path::Path,
    project: &std::path::Path,
    args: &[String],
) -> Execution {
    const WEB_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
    let mut argv: Vec<String> = vec![
        "run".into(),
        "--locked".into(),
        "--no-sync".into(),
        "--project".into(),
        project.to_string_lossy().into_owned(),
        "web-tool".into(),
    ];
    argv.extend(args.iter().cloned());
    // Bounded capture: the browser child (and anything it spawns) is
    // killed with the process group when the tool times out, and output
    // past the cap is cut instead of buffered in full.
    let captured = crate::tools::capture::run(
        program,
        &argv,
        &crate::config::WORKSPACE_DIR,
        WEB_TOOL_TIMEOUT,
        crate::config::MAX_TOOL_OUTPUT_BYTES,
    )
    .await;
    if let Some(error) = captured.spawn_error {
        return Execution {
            stdout: String::new(),
            stderr: format!(
                "Could not run uv web-tool: {error}. Install uv, run uv sync --project web_tool, and install Playwright Chromium."
            ),
            exit_code: None,
            duration_ms: captured.duration_ms,
            raw_body: None,
        };
    }
    let (stderr, raw_body) = split_raw_body(&captured.stderr);
    let mut stderr = stderr;
    if captured.timed_out {
        stderr = format!(
            "Web tool exceeded the {}-second execution timeout. {stderr}",
            WEB_TOOL_TIMEOUT.as_secs()
        );
    }
    Execution {
        stdout: captured.stdout,
        stderr,
        exit_code: captured.exit_code,
        duration_ms: captured.duration_ms,
        raw_body,
    }
}

/// Metadata snapshot of the web-tool implementation. The Python package
/// lives under the agent-writable workspace, so a model that changes it
/// (through an approved `run_cmd`) could otherwise have the change run by
/// the next approved `web_search`/`web_fetch`. We refuse if the source,
/// lock, or entrypoint changes during this harness session.
#[derive(Debug, Clone, PartialEq)]
struct WebToolFileStamp {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

impl WebToolFileStamp {
    fn capture(path: PathBuf) -> Option<Self> {
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Some(Self {
                path,
                len: meta.len(),
                modified: meta.modified().ok(),
                dev: meta.dev(),
                ino: meta.ino(),
            })
        }
        #[cfg(not(unix))]
        {
            Some(Self {
                path,
                len: meta.len(),
                modified: meta.modified().ok(),
            })
        }
    }

    fn matches(&self) -> bool {
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return false;
        };
        if !meta.is_file() || meta.len() != self.len || meta.modified().ok() != self.modified {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            meta.dev() == self.dev && meta.ino() == self.ino
        }
        #[cfg(not(unix))]
        true
    }
}

static WEB_TOOL_STAMP: OnceLock<Option<Vec<WebToolFileStamp>>> = OnceLock::new();

/// Upper bound on the `.venv/lib` walk. A tree past this size is not
/// partially trusted: the web tools refuse until it is understood.
const MAX_VENV_FILES: usize = 50_000;

/// Capture the trusted web-tool file set at startup. Called by `main`;
/// tests that do not call it keep the check dormant.
///
/// The five source/entrypoint files are the first half of the surface.
/// The installed packages under `.venv/lib` are the other half and the
/// deeper one: `uv run --locked --no-sync` will not restore a modified
/// package, so a model that rewrites installed code through an approved
/// `run_cmd` would have that code run by the next approved web call.
/// Both halves are stamped. Directory symlinks are stamped as themselves
/// rather than followed, so a link cycle cannot loop the walk.
pub(crate) fn snapshot_integrity() {
    let root = crate::config::WORKSPACE_DIR.as_path();
    let files = [
        "web_tool/src/web_tool/__init__.py",
        "web_tool/pyproject.toml",
        "web_tool/uv.lock",
        "web_tool/.venv/bin/web-tool",
        "web_tool/.venv/bin/python",
    ];
    let mut stamps: Vec<WebToolFileStamp> = files
        .iter()
        .filter_map(|relative| WebToolFileStamp::capture(root.join(relative)))
        .collect();
    // A tree that cannot be walked within the cap is not partially
    // trusted: clearing the stamps makes every web call refuse (the
    // empty stamp fails closed below) instead of running on unstamped
    // code.
    if !capture_venv(root, &mut stamps, MAX_VENV_FILES) {
        stamps.clear();
    }
    let _ = WEB_TOOL_STAMP.set(Some(stamps));
}

/// Walk `web_tool/.venv/lib` and stamp every file. Returns false when
/// the cap is hit, so the caller can refuse rather than trust a slice.
fn capture_venv(root: &std::path::Path, stamps: &mut Vec<WebToolFileStamp>, cap: usize) -> bool {
    let mut stack = vec![root.join("web_tool/.venv/lib")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if stamps.len() >= cap {
                return false;
            }
            let path = entry.path();
            let Ok(link_meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if link_meta.file_type().is_symlink() {
                // Stamp what the link resolves to, by this path, without
                // descending into a directory link.
                if let Some(stamp) = WebToolFileStamp::capture(path) {
                    stamps.push(stamp);
                }
                continue;
            }
            if link_meta.is_dir() {
                stack.push(path);
                continue;
            }
            if let Some(stamp) = WebToolFileStamp::capture(path) {
                stamps.push(stamp);
            }
        }
    }
    stamps.sort_by(|a, b| a.path.cmp(&b.path));
    true
}

fn integrity_ok() -> bool {
    match WEB_TOOL_STAMP.get() {
        // Not snapshotted: the check is dormant (tests never call
        // snapshot_integrity; production always does).
        None => true,
        // An empty stamp means nothing could be trusted at startup —
        // the web tool was absent, unreadable, or past the walk cap.
        // Refuse rather than run on unstamped code.
        Some(Some(stamps)) => !stamps.is_empty() && stamps.iter().all(WebToolFileStamp::matches),
        // Unreachable today; fail closed if it ever happens.
        Some(None) => false,
    }
}

pub(crate) fn tool_infos() -> Vec<ToolInfo> {
    [json!({"type":"function", "function": {
        "name": SEARCH, "description": crate::model_voice::WEB_SEARCH_DESCRIPTION,
        "parameters": {"type":"object", "properties": {
            "query":{"type":"string"}, "max_results":{"type":"integer", "minimum":1,"maximum":20,"default":5}
        }, "required":["query"], "additionalProperties":false}
    }}), json!({"type":"function", "function": {
        "name": FETCH, "description": crate::model_voice::WEB_FETCH_DESCRIPTION,
        "parameters":{"type":"object", "properties": {
            "url":{"type":"string", "description": crate::model_voice::WEB_FETCH_URL}
        }, "required":["url"],"additionalProperties":false}
    }})].into_iter().map(|v| serde_json::from_value(v).expect("web tool schema")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_venv_walk_stamps_installed_files_and_honors_its_cap() {
        let dir = std::env::temp_dir().join(format!("harness-web-stamp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let site = dir.join("web_tool/.venv/lib/python/site-packages/pkg");
        std::fs::create_dir_all(&site).unwrap();
        std::fs::write(site.join("mod.py"), b"# installed code\n").unwrap();
        std::fs::write(site.join("extra.py"), b"# more installed code\n").unwrap();
        std::fs::write(dir.join("web_tool/.venv/lib/stray.txt"), b"stray\n").unwrap();

        let mut stamps = Vec::new();
        assert!(capture_venv(&dir, &mut stamps, MAX_VENV_FILES));
        let paths: Vec<String> = stamps
            .iter()
            .map(|stamp| stamp.path.display().to_string())
            .collect();
        assert!(paths.iter().any(|p| p.ends_with("pkg/mod.py")), "{paths:?}");
        assert!(paths.iter().any(|p| p.ends_with("pkg/extra.py")), "{paths:?}");
        assert!(paths.iter().any(|p| p.ends_with("stray.txt")), "{paths:?}");
        // Deterministic order, and every stamp still matches.
        let mut sorted = stamps.clone();
        sorted.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(stamps, sorted);
        assert!(stamps.iter().all(WebToolFileStamp::matches));

        // A modified installed file is caught by the stamps.
        std::fs::write(site.join("mod.py"), b"# tampered\n").unwrap();
        assert!(stamps.iter().any(|stamp| !stamp.matches()));

        // A tree past the cap is not partially trusted.
        let mut capped = Vec::new();
        assert!(!capture_venv(&dir, &mut capped, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn argv_preserves_query_as_one_argument_and_fetches_one_url() {
        let query = "words with 'quotes' and $(literal shell syntax)";
        let search = WebRequest::parse(SEARCH, &json!({"query":query,"max_results":2})).unwrap();
        assert_eq!(search.argv(), ["search", query, "2"]);
        let fetch =
            WebRequest::parse(FETCH, &json!({"url":"https://example.com/?a=1&b=2"})).unwrap();
        assert_eq!(fetch.argv(), ["fetch", "https://example.com/?a=1&b=2"]);
        let failure = Execution {
            stdout: "partial content".into(),
            stderr: "network error".into(),
            exit_code: Some(1),
            duration_ms: 10,
            raw_body: None,
        };
        let failure_text = failure.review_text();
        assert!(failure_text.contains("partial content"));
        assert!(failure_text.contains("network error"));
        assert!(!failure_text.contains("Web tool retrieval failed or returned no content"));
        let empty = Execution {
            stdout: String::new(),
            stderr: "network error".into(),
            exit_code: Some(1),
            duration_ms: 1,
            raw_body: None,
        };
        let empty_text = empty.review_text();
        assert!(empty_text.contains("Web tool retrieval failed."));
        assert!(empty_text.contains("network error"));
        assert!(!empty_text.contains("returned no content"));
        let page = failure.fetch_page_text();
        assert!(page.contains("partial content"));
        assert!(!page.contains("network error"));
        let blank = Execution {
            stdout: " \n\t".into(),
            stderr: "network error".into(),
            exit_code: None,
            duration_ms: 0,
            raw_body: None,
        };
        assert_eq!(blank.fetch_page_text(), "Web fetch returned no page text.");
        assert!(!blank.fetch_page_text().contains("network error"));
        let noisy_ok = Execution {
            stdout: "Hello".into(),
            stderr: "refused websocket: wss://example.com\n".into(),
            exit_code: Some(0),
            duration_ms: 1,
            raw_body: None,
        };
        assert_eq!(noisy_ok.fetch_page_text(), "Hello");
        assert_eq!(noisy_ok.review_text(), "Hello");
        let fetch = WebRequest::parse(FETCH, &json!({"url":"https://example.com/a"})).unwrap();
        let quiet = serde_json::to_value(&fetch).unwrap();
        assert!(quiet.get("stderr").is_none(), "{quiet}");
    }

    #[test]
    fn raw_body_sits_beside_the_extraction_and_stays_out_of_review_text() {
        let body = "<html><script>secret-script-token</script></html>";
        let stderr = format!(
            "refused request: private address\n---HARNESS_RAW_BODY bytes={} truncated=0---\n{}\n---HARNESS_RAW_BODY_END---\n",
            body.len(),
            body
        );
        let (cleaned, raw) = split_raw_body(&stderr);
        assert_eq!(raw.as_deref(), Some(body));
        assert_eq!(cleaned, "refused request: private address\n");

        let nested = "prefix\n---HARNESS_RAW_BODY_END---\nsuffix";
        let framed = format!(
            "---HARNESS_RAW_BODY bytes={} truncated=0---\n{}\n---HARNESS_RAW_BODY_END---\n",
            nested.len(),
            nested
        );
        let (cleaned, raw) = split_raw_body(&framed);
        assert_eq!(cleaned, "");
        assert_eq!(raw.as_deref(), Some(nested));

        let (same, none) = split_raw_body("refused request: private address\n");
        assert!(none.is_none());
        assert_eq!(same, "refused request: private address\n");

        let unfinished = "---HARNESS_RAW_BODY bytes=3";
        let (kept, none) = split_raw_body(unfinished);
        assert!(none.is_none());
        assert_eq!(kept, unfinished);

        let cut = "---HARNESS_RAW_BODY bytes=100 truncated=0---\nshort";
        let (cleaned, raw) = split_raw_body(cut);
        assert_eq!(cleaned, "");
        assert_eq!(raw.as_deref(), Some("short"));

        let ok = Execution {
            stdout: "URL: https://example.com\nSource: document.body after JavaScript\nLoad: DOMContentLoaded\nContent:\nHello".into(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 3,
            raw_body: Some(body.into()),
        };
        let review = ok.review_text();
        assert!(review.contains("document.body after JavaScript"));
        assert!(!review.contains("secret-script-token"));
        let preview = serde_json::to_string(&ok).unwrap();
        assert!(preview.contains("secret-script-token"));
        assert!(preview.contains("\"raw_body\""));

        let search = Execution {
            stdout: "URL: https://example.com\nTitle: t\n".into(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 1,
            raw_body: None,
        };
        let search_json = serde_json::to_string(&search).unwrap();
        assert!(!search_json.contains("raw_body"));
        assert_eq!(search.review_text(), search.stdout);
    }

    #[test]
    fn validates_requests_and_preserves_literal_results() {
        let r = WebRequest::parse(SEARCH, &json!({"query":"test"})).unwrap();
        assert_eq!(r.max_results, Some(5));
        for a in [
            json!({"query":" "}),
            json!({"query":"x","max_results":0}),
            json!({"query":"x","max_results":21}),
        ] {
            assert!(WebRequest::parse(SEARCH, &a).is_err());
        }
        assert!(r.result(" ".into()).is_err());
        assert_eq!(
            r.result("  <data>\nraw  ".into()).unwrap()["results"],
            "  <data>\nraw  "
        );
        assert!(WebRequest::parse(FETCH, &json!({"url":"file:///etc/passwd"})).is_err());
        let r = WebRequest::parse(FETCH, &json!({"url":"https://example.com"})).unwrap();
        assert_eq!(
            r.result("No accessible content".into()).unwrap()["content"],
            "No accessible content"
        );
    }

    #[test]
    fn fetch_targets_reject_local_and_credential_forms() {
        // Local IP literals and internal names are refused as argument
        // errors, not silently executed.
        for url in [
            "http://127.0.0.1/page",
            "http://[::1]/page",
            "http://10.0.0.8/page",
            "http://192.168.1.4/",
            "http://172.16.5.5/",
            "http://169.254.169.254/latest/meta-data",
            "http://localhost/x",
            "http://intranet.localhost/x",
            "https://mesh.local/x",
            "http://0.0.0.0/",
            // Carrier-grade NAT: cloud metadata endpoints live here.
            "http://100.100.100.200/latest/meta-data",
            "http://192.0.0.192/",
            "http://198.18.0.1/",
            // IPv4-mapped loopback/private and transition mechanisms.
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:169.254.169.254]/",
            "http://[2002:7f00:1::]/",
            "http://[64:ff9b::7f00:1]/",
        ] {
            let err = WebRequest::parse(FETCH, &json!({"url":url})).unwrap_err();
            assert!(err.contains("refusing to fetch"), "{url}: {err}");
        }
        // Control characters are never valid in a fetch URL.
        assert!(
            WebRequest::parse(FETCH, &json!({"url":"https://example.com/\u{1b}[31m"})).is_err()
        );
        // Look-alike forms Chromium would still normalize into loopback.
        assert!(
            WebRequest::parse(FETCH, &json!({"url":"https://user:pass@example.com/x"})).is_err()
        );
        assert!(WebRequest::parse(FETCH, &json!({"url":"https://example.com/x"})).is_ok());
    }

    #[test]
    fn query_named_like_secrets_surfaces_a_notice_only() {
        let r = WebRequest::parse(
            FETCH,
            &json!({"url":"https://example.com/search?q=token=abc&x=1"}),
        )
        .unwrap();
        assert_eq!(r.notices.len(), 1, "got {:?}", r.notices);
        assert!(r.notices[0].contains("sensitive-looking"));
        let r =
            WebRequest::parse(FETCH, &json!({"url":"https://example.com/page?q=rust"})).unwrap();
        assert!(r.notices.is_empty());
    }
}
