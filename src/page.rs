//! The single frontend page: the compiled-in assets (markup, styles,
//! scripts), the launch identity (token, nonce, comment key), and the
//! page handler that assembles and serves them.

use axum::{
    extract::State,
    response::{Html, IntoResponse},
};

use crate::config::{AppState, InstalledModels, current_model, installed_models, model_groups_json};

// Frontend sources live in `web/` (markup, styles, one module per concern)
// and are assembled into one response. A debug build reads them from disk
// on each request, so a browser refresh picks up script and style edits.
// A release build keeps the copies compiled in below. Load order is the
// module contract (plain script, no bundler): core -> icon -> tabs ->
// tooltest -> vim -> modelmenu -> rounds -> subtabs -> prompt -> approval ->
// prism-manual -> vendored Prism core + languages -> vendored KaTeX ->
// highlight -> stream -> scroll -> storage -> history -> memory -> decision
// -> workspace -> boot. Prism is vendored under `web/vendor/` (no CDN,
// offline-safe); `prism-manual.js` must precede the core.
// `WEB_JS_FILES` must stay in the same order as `APP_JS`.
pub(crate) const TEMPLATE: &str = include_str!("../web/index.html");
pub(crate) const STYLE: &str = include_str!("../web/style.css");
/// Up-chevron for the expanded-text jump links. The page turns it over
/// for the downward jump. Inlined so the single offline response needs
/// no image route and no CSP change.
const SCROLL_ARROW_PNG: &[u8] = include_bytes!("../web/scroll_arrow_blue.png");
static SCROLL_ARROW_DATA_URI: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    use base64::Engine;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(SCROLL_ARROW_PNG)
    )
});
pub(crate) const APP_JS: &str = concat!(
    include_str!("../web/js/core.js"),
    include_str!("../web/js/icon.js"),
    include_str!("../web/js/tabs.js"),
    include_str!("../web/js/tooltest.js"),
    include_str!("../web/js/vim.js"),
    include_str!("../web/js/modelmenu.js"),
    include_str!("../web/js/rounds.js"),
    include_str!("../web/js/subtabs.js"),
    include_str!("../web/js/prompt.js"),
    include_str!("../web/js/approval.js"),
    include_str!("../web/js/prism-manual.js"),
    include_str!("../web/vendor/prism-core.min.js"),
    include_str!("../web/vendor/prism-clike.min.js"),
    include_str!("../web/vendor/prism-bash.min.js"),
    include_str!("../web/vendor/prism-c.min.js"),
    include_str!("../web/vendor/prism-cpp.min.js"),
    include_str!("../web/vendor/prism-go.min.js"),
    include_str!("../web/vendor/prism-python.min.js"),
    include_str!("../web/vendor/prism-markup.min.js"),
    include_str!("../web/vendor/prism-css.min.js"),
    include_str!("../web/vendor/prism-javascript.min.js"),
    include_str!("../web/vendor/prism-typescript.min.js"),
    include_str!("../web/vendor/prism-json.min.js"),
    include_str!("../web/vendor/prism-java.min.js"),
    include_str!("../web/vendor/prism-kotlin.min.js"),
    include_str!("../web/vendor/prism-lua.min.js"),
    include_str!("../web/vendor/prism-perl.min.js"),
    include_str!("../web/js/prism-mojo.js"),
    include_str!("../web/vendor/prism-gdscript.min.js"),
    include_str!("../web/js/prism-gdscript.js"),
    include_str!("../web/vendor/prism-rust.min.js"),
    include_str!("../web/vendor/prism-odin.min.js"),
    include_str!("../web/vendor/katex.min.js"),
    include_str!("../web/js/highlight.js"),
    include_str!("../web/js/stream.js"),
    include_str!("../web/js/scroll.js"),
    include_str!("../web/js/storage.js"),
    include_str!("../web/js/history.js"),
    include_str!("../web/js/memory.js"),
    include_str!("../web/js/decision.js"),
    include_str!("../web/js/workspace.js"),
    include_str!("../web/js/boot.js"),
);

/// Debug reads and the source-consistency test use this list; release
/// builds serve the compiled-in `APP_JS` and do not need disk paths.
#[cfg(any(debug_assertions, test))]
pub(crate) const WEB_JS_FILES: &[&str] = &[
    "web/js/core.js",
    "web/js/icon.js",
    "web/js/tabs.js",
    "web/js/tooltest.js",
    "web/js/vim.js",
    "web/js/modelmenu.js",
    "web/js/rounds.js",
    "web/js/subtabs.js",
    "web/js/prompt.js",
    "web/js/approval.js",
    "web/js/prism-manual.js",
    "web/vendor/prism-core.min.js",
    "web/vendor/prism-clike.min.js",
    "web/vendor/prism-bash.min.js",
    "web/vendor/prism-c.min.js",
    "web/vendor/prism-cpp.min.js",
    "web/vendor/prism-go.min.js",
    "web/vendor/prism-python.min.js",
    "web/vendor/prism-markup.min.js",
    "web/vendor/prism-css.min.js",
    "web/vendor/prism-javascript.min.js",
    "web/vendor/prism-typescript.min.js",
    "web/vendor/prism-json.min.js",
    "web/vendor/prism-java.min.js",
    "web/vendor/prism-kotlin.min.js",
    "web/vendor/prism-lua.min.js",
    "web/vendor/prism-perl.min.js",
    "web/js/prism-mojo.js",
    "web/vendor/prism-gdscript.min.js",
    "web/js/prism-gdscript.js",
    "web/vendor/prism-rust.min.js",
    "web/vendor/prism-odin.min.js",
    "web/vendor/katex.min.js",
    "web/js/highlight.js",
    "web/js/stream.js",
    "web/js/scroll.js",
    "web/js/storage.js",
    "web/js/history.js",
    "web/js/memory.js",
    "web/js/decision.js",
    "web/js/workspace.js",
    "web/js/boot.js",
];

#[cfg(any(debug_assertions, test))]
pub(crate) fn read_web_page() -> Result<(String, String, String), std::io::Error> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let html = std::fs::read_to_string(root.join("web/index.html"))?;
    let css = std::fs::read_to_string(root.join("web/style.css"))?;
    let mut js = String::new();
    for rel in WEB_JS_FILES {
        js.push_str(&std::fs::read_to_string(root.join(rel))?);
    }
    Ok((html, css, js))
}

fn page_sources() -> (
    std::borrow::Cow<'static, str>,
    std::borrow::Cow<'static, str>,
    std::borrow::Cow<'static, str>,
) {
    // Debug reads the files so a refresh shows JS edits. A missing file
    // falls back to the copy compiled into this binary.
    #[cfg(debug_assertions)]
    if let Ok((html, css, js)) = read_web_page() {
        return (
            std::borrow::Cow::Owned(html),
            std::borrow::Cow::Owned(css),
            std::borrow::Cow::Owned(js),
        );
    }
    (
        std::borrow::Cow::Borrowed(TEMPLATE),
        std::borrow::Cow::Borrowed(STYLE),
        std::borrow::Cow::Borrowed(APP_JS),
    )
}
/// Per-launch bearer token. Every request must carry it (see
/// [`crate::auth`]); the page receives it through the URL that opens the
/// harness. Loopback is a network boundary, not an identity check, so
/// without this any local process could drive the harness — and approve
/// the shell commands it asks for.
pub(crate) static HARNESS_TOKEN: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(random_token);

/// The token for this launch.
pub(crate) fn harness_token() -> &'static str {
    HARNESS_TOKEN.as_str()
}

/// Per-launch nonce for the single inline application script. A random
/// nonce lets the page use a strict `script-src` policy without
/// `'unsafe-inline'`, so injected markup cannot become script.
static CSP_NONCE: std::sync::LazyLock<String> = std::sync::LazyLock::new(random_token);

fn csp_nonce() -> &'static str {
    CSP_NONCE.as_str()
}

/// Per-launch 256-bit key for co-pilot annotations inside tool results.
/// Independent of [`HARNESS_TOKEN`]: the marker is written into the system
/// prompt and into text the model reads, so it must not reveal the bearer
/// token that authenticates the page. The annotation is the first 20 hex
/// characters (80 bits: the marker tells the model which span of a tool
/// result is the person speaking, so content that wants to forge that
/// voice must not be able to guess it). The browser shows those tags as
/// `<user_comment>` everywhere except the live curation box. Runs recorded
/// before the length moved to 20 carry a 12-hex marker; the page still
/// accepts that length so those transcripts replay.
pub(crate) static COMMENT_KEY: std::sync::LazyLock<String> = std::sync::LazyLock::new(random_token);

/// The 20-character annotation for this launch. `random_token` is at least
/// 32 hex characters, so the slice is the first 20.
pub(crate) fn comment_tag() -> &'static str {
    &COMMENT_KEY[..20]
}

/// Extra host names the harness answers to, comma-separated, from
/// `HARNESS_ALLOWED_HOSTS`. For setups that reach the harness through a
/// tunnel or a reverse proxy. Off by default: every extra name is also
/// a name an attacker can put in a Host header.
pub(crate) fn extra_allowed_hosts() -> Vec<String> {
    std::env::var("HARNESS_ALLOWED_HOSTS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(|host| host.trim().to_ascii_lowercase())
                .filter(|host| !host.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 256 bits of randomness for the launch token and the CSP nonce.
/// `/dev/urandom` is the only source: the launch token is the sole
/// identity check on the privileged loopback surface, and a weaker
/// fallback (clock, pid, addresses) would quietly turn a broken system
/// into a predictable token an attacker could guess. Refusing to start
/// is the safe failure.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    let mut file = std::fs::File::open("/dev/urandom").unwrap_or_else(|error| {
        panic!(
            "harness: could not open /dev/urandom ({error}). The launch token cannot be generated; refusing to start with a predictable one."
        )
    });
    use std::io::Read;
    file.read_exact(&mut bytes).unwrap_or_else(|error| {
        panic!(
            "harness: could not read 32 bytes from /dev/urandom ({error}). The launch token cannot be generated; refusing to start with a predictable one."
        )
    });
    hex_encode(&bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}
/// Assemble the single page for `installed` chat models. Tests call this
/// with a fixed list so the bytes do not depend on a live Ollama daemon.
pub(crate) fn page_response(installed: &InstalledModels) -> axum::response::Response {
    let nonce = csp_nonce();
    let (template, style, app_js) = page_sources();
    let mut response = Html(
        template
            .replace("/*__APP_CSS__*/", &style)
            .replace("/*__APP_JS__*/", &app_js)
            .replace("{SCROLL_ARROW}", &SCROLL_ARROW_DATA_URI)
            .replace("{CSP_NONCE}", nonce)
            .replace("{MODEL}", &current_model())
            .replace("{MODEL_GROUPS}", &model_groups_json(installed))
            .replace("{TOKEN}", harness_token()),
    )
    .into_response();
    let headers = response.headers_mut();
    // The page carries the launch token: never let a cache keep it.
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        axum::http::header::X_FRAME_OPTIONS,
        axum::http::HeaderValue::from_static("DENY"),
    );
    // The application is one inline script with a per-launch nonce. No
    // inline event handlers are used in the page; `style-src
    // 'unsafe-inline'` remains required for the inline stylesheet and the
    // few style attributes in the markup. `connect-src 'self'` limits an
    // injected script's ability to exfiltrate the token off-machine.
    let csp = format!(
        "default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; \
         img-src 'self' data:; font-src 'self' data:; connect-src 'self'; \
         worker-src 'none'; media-src 'none'; frame-src 'none'; \
         frame-ancestors 'none'; form-action 'self'; object-src 'none'; base-uri 'self'"
    );
    headers.insert(
        axum::http::header::CONTENT_SECURITY_POLICY,
        axum::http::HeaderValue::from_str(&csp)
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("default-src 'none'")),
    );
    headers.insert(
        axum::http::header::REFERRER_POLICY,
        axum::http::HeaderValue::from_static("no-referrer"),
    );
    response
}

/// Serve the assembled single page. Local chat models are read from the
/// user's Ollama; a daemon that cannot be reached still serves the cloud
/// catalog and the Grok list. Framing and referrer are locked down:
/// the approval dialog executes shell commands, so a remote page must not
/// be able to render this UI in an iframe and clickjack it.
pub async fn index_html(State(state): State<AppState>) -> impl IntoResponse {
    let installed = match installed_models(&state.ollama).await {
        Ok(installed) => installed,
        Err(err) => {
            eprintln!("local models: {err}");
            InstalledModels::default()
        }
    };
    page_response(&installed)
}
