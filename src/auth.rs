//! Request authentication for the harness' HTTP surface.
//!
//! The harness executes shell commands on the user's machine, so every
//! route is privileged even though the server binds to loopback:
//! loopback is a network boundary, not an identity check. Two layers
//! keep the surface usable by the page and closed to everyone else:
//!
//! - **Per-launch bearer token.** A 256-bit random token is generated
//!   at startup, printed in the URL that opens the harness, and
//!   required on every request (header `X-Harness-Token`, or the `t`
//!   query parameter for the page itself). Another local process or
//!   local user can connect to the port but cannot guess the token.
//! - **Host allow-list.** The server answers only to the loopback
//!   names it is served under. A DNS-rebinding page resolves to
//!   127.0.0.1 and therefore becomes same-origin with the harness —
//!   the token check alone would not stop it, because the rebound
//!   browser would send the attacker's own token. The `Host` header
//!   is the one signal the server gets, and a rebound request carries
//!   the attacker's Host.
//!
//! Cross-site browser requests are refused as well: a state-changing
//! request must not come from another origin.
use axum::{
    extract::Request,
    http::{HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

/// Header the browser sends the per-launch token in.
pub(crate) const TOKEN_HEADER: &str = "x-harness-token";
/// Query parameter the page URL carries the token in.
pub(crate) const TOKEN_PARAM: &str = "t";

/// Host names the harness answers to (loopback only).
const ALLOWED_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

/// What a caller without the token is told.
const MISSING_TOKEN: &str = "This harness requires its per-launch token.\n\
     Open the URL printed when the harness started (it ends with ?t=<token>), \
     or send the token in the X-Harness-Token header.";

/// Split a `Host` header value into its name, ignoring a trailing port.
///
/// IPv6 literals are bracketed (`[::1]:3239`), so the brackets are parsed
/// before any port logic. Bare IPv6 names (`::1`) must not be treated as
/// `("::", "1")`; doing so would turn a legitimate loopback name into the
/// unspecified address and misclassify it.
fn host_name(host: &str) -> &str {
    let host = host.trim();
    if host.starts_with('[')
        && let Some(close) = host.find(']')
    {
        let suffix = &host[close + 1..];
        if suffix.is_empty()
            || (suffix.starts_with(':')
                && suffix[1..].bytes().all(|b| b.is_ascii_digit())
                && suffix.len() > 1)
        {
            return &host[1..close];
        }
        return "";
    }
    // A non-bracketed host can carry a `:port` only when it has one colon.
    // Bare IPv6 contains several colons and is never split here.
    if host.matches(':').count() == 1
        && let Some((name, port)) = host.rsplit_once(':')
        && !port.is_empty()
        && port.bytes().all(|b| b.is_ascii_digit())
    {
        return name;
    }
    host
}

/// True when `host` is one of the loopback names the harness is served
/// under (plus any explicitly allowed extra). The port is ignored;
/// only the name matters.
fn host_allowed(host: &str) -> bool {
    let name = host_name(host).to_ascii_lowercase();
    ALLOWED_HOSTS.contains(&name.as_str())
        || crate::config::extra_allowed_hosts()
            .iter()
            .any(|allowed| allowed == &name)
}

/// The origin a host name is served under.
fn origin_for(host: &str) -> String {
    if host.contains(':') {
        // IPv6 literal: "http://[::1]:3239".
        format!("http://[{host}]:{}", crate::config::PORT)
    } else {
        format!("http://{host}:{}", crate::config::PORT)
    }
}

/// Origins the page may be served from.
fn origin_allowed(origin: &str) -> bool {
    ALLOWED_HOSTS.iter().any(|host| origin == origin_for(host))
        || crate::config::extra_allowed_hosts()
            .iter()
            .any(|host| origin == origin_for(host))
}

/// A lightweight global budget for state-changing requests. There is one
/// launch token and one user, so a per-token bucket would be equivalent;
/// this still stops a runaway local script from hammering /approve or
/// /render. Normal approval-driven chains stay far below the limit.
const STATE_CHANGE_WINDOW: Duration = Duration::from_secs(60);
const STATE_CHANGE_LIMIT: usize = 240;

static STATE_CHANGES: std::sync::LazyLock<Mutex<VecDeque<Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(VecDeque::new()));

fn state_change_allowed() -> bool {
    let now = Instant::now();
    let mut changes = STATE_CHANGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    while changes
        .front()
        .is_some_and(|at| now.duration_since(*at) >= STATE_CHANGE_WINDOW)
    {
        changes.pop_front();
    }
    if changes.len() >= STATE_CHANGE_LIMIT {
        return false;
    }
    changes.push_back(now);
    true
}

/// Compare two secrets without an early exit on the first difference.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Pull one query parameter out of a raw query string. The token is
/// hexadecimal, so no percent-decoding is needed for it.
fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let query = query?;
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (name == key).then(|| value.to_string())
    })
}

/// Guard every route: host allow-list, bearer token, and (for
/// state-changing requests) a same-origin browser.
pub(crate) async fn guard(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !host_allowed(host) {
        return (
            StatusCode::FORBIDDEN,
            format!("Host {host:?} is not served by this harness."),
        )
            .into_response();
    }

    let token = crate::config::harness_token();
    let header_token = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    // The page URL carries the token; every other route needs the header.
    let query_token = if request.uri().path() == "/" {
        query_param(request.uri().query(), TOKEN_PARAM).unwrap_or_default()
    } else {
        String::new()
    };
    if !constant_time_eq(header_token, token) && !constant_time_eq(&query_token, token) {
        return (StatusCode::UNAUTHORIZED, MISSING_TOKEN).into_response();
    }

    if !matches!(request.method(), &Method::GET | &Method::HEAD) {
        if let Some(origin) = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            && !origin_allowed(origin)
        {
            return (
                StatusCode::FORBIDDEN,
                "Cross-origin request refused by the harness.",
            )
                .into_response();
        }
        if let Some(site) = request
            .headers()
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok())
            && site == "cross-site"
        {
            return (
                StatusCode::FORBIDDEN,
                "Cross-site request refused by the harness.",
            )
                .into_response();
        }
        if !state_change_allowed() {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many state-changing requests — slow down.".to_string(),
            )
                .into_response();
        }
    }

    let mut response = next.run(request).await;
    // These are cheap, universally safe response defaults. In particular,
    // transcripts returned by /history must not be retained by a browser
    // cache; the page itself carries the launch token and is no-store too.
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

#[cfg(test)]
mod auth_tests {
    use super::*;

    #[test]
    fn only_loopback_hosts_are_answered() {
        for host in [
            "127.0.0.1:3239",
            "127.0.0.1",
            "localhost:3239",
            "LOCALHOST:3239",
            "[::1]:3239",
            "[::1]",
            "::1",
        ] {
            assert!(host_allowed(host), "{host} should be allowed");
        }
        for host in [
            "evil.com:3239",
            "127.0.0.1.evil.com:3239",
            "127.0.0.1.evil.com",
            "localhost.evil.com",
            "10.0.0.5:3239",
            "127.0.0.1:3239:80",
            "localhost:not-a-port",
            "[::1]evil",
            "[::1]:not-a-port",
            "",
        ] {
            assert!(!host_allowed(host), "{host} should be refused");
        }
    }

    #[test]
    fn state_changing_requests_have_a_bounded_budget() {
        for _ in 0..STATE_CHANGE_LIMIT {
            assert!(state_change_allowed());
        }
        assert!(!state_change_allowed());
    }

    #[test]
    fn the_token_comparison_does_not_short_circuit() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(!constant_time_eq("", "abc"));
    }

    #[test]
    fn query_parameters_are_extracted_by_name() {
        assert_eq!(
            query_param(Some("t=deadbeef&x=1"), TOKEN_PARAM).as_deref(),
            Some("deadbeef")
        );
        assert_eq!(
            query_param(Some("x=1&t=deadbeef"), TOKEN_PARAM).as_deref(),
            Some("deadbeef")
        );
        assert_eq!(query_param(Some("x=1"), TOKEN_PARAM), None);
        assert_eq!(query_param(None, TOKEN_PARAM), None);
    }

    #[test]
    fn only_the_pages_own_origins_are_allowed() {
        assert!(origin_allowed("http://127.0.0.1:3239"));
        assert!(origin_allowed("http://localhost:3239"));
        assert!(!origin_allowed("http://evil.com:3239"));
        assert!(!origin_allowed("null"));
        assert!(!origin_allowed(""));
    }
}
