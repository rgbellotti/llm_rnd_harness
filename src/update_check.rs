//! Optional, non-blocking update check for the `web_tool` venv.
//!
//! This is **off by default**. `uv pip list --python <interpreter>` asks
//! the supplied interpreter for its environment, which means it executes
//! that interpreter. Since the venv lives under the agent-writable
//! workspace, an automatic check would be an unapproved execution path:
//! anything that can write `web_tool/.venv/bin/python` could run code on
//! the next harness start. Operators who want the convenience check can
//! opt in explicitly with `WEB_TOOL_UPDATE_CHECK=1`.
//!
//! When enabled, the check is bounded through [`crate::tools::capture`]:
//! a 45-second timeout, a 1 MB output cap, and process-group cleanup.
//! Disable it again with `WEB_TOOL_UPDATE_CHECK=0` (or unset it).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CHECK_INTERVAL_SECS: u64 = 7 * 24 * 60 * 60;
const CHECK_TIMEOUT: Duration = Duration::from_secs(45);
const CHECK_OUTPUT_CAP: usize = 1024 * 1024;

/// Marker file lives next to the project it describes.
fn marker_path(root: &str) -> PathBuf {
    PathBuf::from(root)
        .join("web_tool")
        .join(".last_update_check")
}

fn stale(marker: &PathBuf) -> bool {
    match std::fs::read_to_string(marker) {
        Ok(text) => {
            let last: u64 = text.trim().parse().unwrap_or(0);
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            now.saturating_sub(last) >= CHECK_INTERVAL_SECS
        }
        Err(_) => true,
    }
}

fn stamp(marker: &PathBuf) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(marker, now.to_string());
}

pub(crate) fn schedule(runner: PathBuf, root: std::string::String) {
    // Explicit opt-in: default is OFF because the check executes the
    // workspace venv interpreter. `0` is accepted as an explicit off.
    if std::env::var("WEB_TOOL_UPDATE_CHECK").ok().as_deref() != Some("1") {
        return;
    }
    if !PathBuf::from(&root).join("web_tool").exists() {
        return;
    }
    let marker = marker_path(&root);
    if !stale(&marker) {
        return;
    }
    // Stamp before querying so a crash of the check doesn't re-run it every
    // startup; the next weekly window picks it back up.
    stamp(&marker);

    tokio::spawn(async move {
        let python = PathBuf::from(&root)
            .join("web_tool")
            .join(".venv")
            .join("bin")
            .join("python");
        if !python.exists() {
            return; // venv not installed yet; setup instructions cover this.
        }
        eprintln!(
            "web-tool update check: enabled by WEB_TOOL_UPDATE_CHECK=1; executing the workspace venv interpreter (bounded to {}s)",
            CHECK_TIMEOUT.as_secs()
        );
        let args = vec![
            "pip".to_string(),
            "list".to_string(),
            "--outdated".to_string(),
            "--python".to_string(),
            python.to_string_lossy().into_owned(),
        ];
        let captured = crate::tools::capture::run(
            Path::new(&runner),
            &args,
            Path::new(&root),
            CHECK_TIMEOUT,
            CHECK_OUTPUT_CAP,
        )
        .await;
        if let Some(error) = captured.spawn_error {
            eprintln!("web-tool update check skipped: {error}");
            return;
        }
        if captured.timed_out {
            eprintln!(
                "web-tool update check timed out after {}s and was killed",
                CHECK_TIMEOUT.as_secs()
            );
            return;
        }
        if captured.exit_code != Some(0) {
            return;
        }
        let listing = captured.stdout.trim();
        if !listing.is_empty() {
            eprintln!(
                "web-tool update check: newer dependencies available:\n{listing}\n(run `uv sync --project web_tool` to update)"
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_throttles_within_a_week() {
        let dir = std::env::temp_dir().join("harness_update_check");
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join(".last_update_check");
        let _ = std::fs::remove_file(&marker);
        assert!(stale(&marker), "missing marker is stale");
        stamp(&marker);
        assert!(!stale(&marker), "just-stamped marker is fresh");
        std::fs::write(&marker, "0").unwrap();
        assert!(stale(&marker), "epoch marker is stale");
        let _ = std::fs::remove_file(&marker);
    }
}
