//! Local PDF text extraction, behind the same two-stage human gate as the
//! web tools. Stage one approves the read itself; stage two (text mode
//! only, and only when extraction produced content) shows the extracted
//! text for review before any of it reaches the model — noisy or hostile
//! documents get trimmed by the user, not the model.
//!
//! Backend: poppler (`pdfinfo` + `pdftotext`) as subprocesses, reusing the
//! same bounded capture as `run_cmd`. No file is read at argument-parse
//! time beyond the first five bytes (the `%PDF-` magic check); everything
//! else happens after the user approves.
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use ollama_rs::generation::tools::ToolInfo;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::web::Execution;

pub const READ: &str = "read_pdf";

/// Soft cap on extracted text handed to the model, page-boundary cut.
/// A 400-page PDF must not flood the context; the tool result carries an
/// explicit continuation hint instead of a silent cut.
const MAX_PDF_TEXT_BYTES: usize = 256 * 1024;
/// Refuse absurdly large inputs before handing them to poppler.
const MAX_PDF_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// A request may name at most this many page ranges; each range is a
/// separate poppler invocation.
const MAX_PAGE_RANGES: usize = 64;
/// The only bytes read before execution are the five-byte PDF signature.
const PDF_MAGIC: &[u8; 5] = b"%PDF-";
/// poppler wrapper; extraction is fast, but a hostile document could
/// stall it — the same timeout shape as `run_cmd` applies.
const PDF_TIMEOUT: Duration = Duration::from_secs(30);
const TOOL_MISSING: &str =
    "could not run poppler (pdfinfo/pdftotext). Install poppler-utils and try again.";
const PASSWORD_FAILURE: &str = "PDF is password-protected (user password). The harness has no password channel — \
     open it locally and save an unencrypted copy, or supply the file decrypted.";

/// Result of one poppler invocation, before formatting decisions.
struct PopplerRun {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    duration_ms: u64,
    timed_out: bool,
    spawn_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct PdfRequest {
    /// Discriminator for the review modal (the frontend branches on this).
    pub kind: String,
    /// Canonical absolute path (relative paths resolve against the workspace).
    pub path: String,
    /// Raw `pages` argument as given by the model ("1-3", "7", "2,5-7");
    /// syntax is validated at parse time, bounds at execution time.
    pub pages: Option<String>,
    /// "reading" (logical order), "raw" (content-stream order), or
    /// "layout" (visual columns preserved).
    pub layout: String,
    /// "text" (info + extracted text, two-stage review) or "info"
    /// (metadata only, single approval, nothing for a human to curate).
    pub mode: String,
    /// Set at the review stage: the extracted text awaiting submission.
    pub preview: Option<String>,
}

impl PdfRequest {
    pub fn parse(name: &str, args: &Value) -> Result<Self, String> {
        if name != READ {
            return Err("unknown read_pdf invocation".into());
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            path: String,
            pages: Option<String>,
            layout: Option<String>,
            mode: Option<String>,
        }
        let a: Args = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
        let trimmed = a.path.trim();
        if trimmed.is_empty() {
            return Err("provide a non-empty path".into());
        }
        if trimmed.chars().any(|c| c.is_control() || c == '\0') {
            return Err("path contains control characters".into());
        }
        // Deliberately no filesystem access here: the path is only checked
        // (canonicalized, statted, and magic-byte tested) after the user
        // approves the read. Parsing must not become a pre-approval
        // existence/type oracle for the model.
        let request = Self {
            kind: "pdf".into(),
            path: trimmed.to_string(),
            pages: a
                .pages
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty()),
            layout: checked_one_of(
                a.layout.as_deref().unwrap_or("reading"),
                &["reading", "raw", "layout"],
                "layout",
            )?,
            mode: checked_one_of(
                a.mode.as_deref().unwrap_or("text"),
                &["text", "info"],
                "mode",
            )?,
            preview: None,
        };
        // Bounds-agnostic syntax check; bounds are validated at execution
        // time once pdfinfo knows the page count.
        if let Some(raw) = &request.pages {
            validate_pages(raw)?;
        }
        Ok(request)
    }

    /// Resolve and validate the path immediately before execution, after
    /// the user has approved the read. This is where canonicalization,
    /// regular-file checks, the size limit, and the PDF signature test
    /// happen.
    fn resolved(&self) -> Result<Self, String> {
        let mut resolved = self.clone();
        resolved.path = canonical_pdf_path(&self.path)?;
        Ok(resolved)
    }

    /// Parsed page ranges (1-based, inclusive). Infallible after parse-time
    /// validation; any inconsistency degrades to the whole document.
    fn ranges(&self, total_pages: Option<u32>) -> Vec<(u32, u32)> {
        let Some(raw) = &self.pages else {
            let end = total_pages.unwrap_or(u32::MAX);
            return vec![(1, end)];
        };
        let parsed: Vec<(u32, u32)> = raw
            .split(',')
            .filter_map(|part| {
                let (a, b) = part.split_once('-').unwrap_or((part, part));
                Some((a.trim().parse::<u32>().ok()?, b.trim().parse::<u32>().ok()?))
            })
            .filter(|&(start, end)| start >= 1 && start <= end)
            .collect();
        if parsed.is_empty() {
            vec![(1, total_pages.unwrap_or(u32::MAX))]
        } else {
            parsed
        }
    }

    /// argv for one `pdftotext` run over one page range (1-based, inclusive).
    /// `None` means "no page flags at all" — used when the caller wants the
    /// whole document and pdfinfo could not tell us how many pages it has.
    fn extract_argv(&self, range: Option<(u32, u32)>) -> Vec<String> {
        let mut argv = Vec::new();
        if let Some((start, end)) = range {
            argv.extend([
                "-f".to_string(),
                start.to_string(),
                "-l".to_string(),
                end.to_string(),
            ]);
        }
        match self.layout.as_str() {
            "raw" => argv.push("-raw".to_string()),
            "layout" => argv.push("-layout".to_string()),
            _ => {}
        }
        argv.push(self.path.clone());
        argv.push("-".to_string());
        argv
    }

    pub async fn execute(&self) -> Execution {
        let start = std::time::Instant::now();
        let fail = |stderr: String, exit_code: Option<i32>, millis: u64| Execution {
            stdout: String::new(),
            stderr,
            exit_code,
            duration_ms: millis,
            raw_body: None,
        };

        let request = match self.resolved() {
            Ok(request) => request,
            Err(error) => {
                return fail(format!("read_pdf path rejected: {error}"), None, 0);
            }
        };

        let info = run_poppler(std::slice::from_ref(&request.path), Path::new("pdfinfo")).await;
        if let Some(error) = info.spawn_error {
            return fail(format!("{TOOL_MISSING} ({error})"), None, info.duration_ms);
        }
        if info.exit_code != Some(0) && looks_like_password_failure(&info.stderr) {
            return fail(PASSWORD_FAILURE.into(), info.exit_code, info.duration_ms);
        }
        let pdfinfo_ok = info.exit_code == Some(0);
        let total_pages = parse_pages(&info.stdout);

        if request.mode == "info" {
            return Execution {
                stdout: render_info(
                    &request.path,
                    &info.stdout,
                    pdfinfo_ok,
                    &info.stderr,
                    total_pages,
                ),
                stderr: if pdfinfo_ok {
                    String::new()
                } else {
                    info.stderr.clone()
                },
                exit_code: info.exit_code.or(Some(0)),
                duration_ms: info.duration_ms,
                raw_body: None,
            };
        }

        // Zero pages: nothing to extract, no point opening the review gate.
        if total_pages == Some(0) {
            return fail(
                "PDF contains 0 pages — nothing to read.".to_string(),
                info.exit_code,
                info.duration_ms,
            );
        }
        // Bounds check against pdfinfo when the page count is known.
        if let Some(total) = total_pages {
            for (start_page, _) in request.ranges(total_pages) {
                if start_page > total {
                    return fail(
                        format!(
                            "page {start_page} of {total} — adjust the pages argument to 1-{total}."
                        ),
                        None,
                        info.duration_ms,
                    );
                }
            }
        }

        // Extract per requested range, then splice pages with markers and
        // cut at a page boundary when the 256 KB budget runs out.
        let mut page_blocks: Vec<(u32, String)> = Vec::new();
        let mut capture_cut = false;
        for (start_page, end_page) in request.ranges(total_pages) {
            // Whole-document read with no pdfinfo: no page flags (pdftotext
            // clamps over-long -l values, but u32::MAX is silly to send).
            let range = (request.pages.is_some() || total_pages.is_some())
                .then_some((start_page, end_page));
            let run = run_poppler(&request.extract_argv(range), Path::new("pdftotext")).await;
            if let Some(error) = run.spawn_error {
                return fail(format!("{TOOL_MISSING} ({error})"), None, run.duration_ms);
            }
            if run.timed_out {
                return fail(
                    format!(
                        "pdftotext exceeded the {}-second timeout on pages {start_page}-{end_page}.",
                        PDF_TIMEOUT.as_secs()
                    ),
                    None,
                    run.duration_ms,
                );
            }
            if run.exit_code != Some(0) {
                let detail = run.stderr.trim();
                return fail(
                    format!(
                        "pdftotext failed on pages {start_page}-{end_page}: {}",
                        if detail.is_empty() {
                            "unknown error"
                        } else {
                            detail
                        }
                    ),
                    run.exit_code,
                    run.duration_ms,
                );
            }
            capture_cut |= run.stdout.contains(crate::tools::capture::TRUNCATED_MARKER);
            // poppler terminates every page with \f; the trailing segment
            // is empty, and the count of printed pages equals the count of
            // form feeds (fewer only when the capture cap cut the stream).
            let segments = split_pages(&run.stdout);
            let produced = if segments.last().map(|s| s.is_empty()).unwrap_or(false) {
                segments.len() - 1
            } else {
                segments.len()
            };
            for (offset, page_text) in segments.into_iter().take(produced).enumerate() {
                let Some(page_number) = start_page.checked_add(offset as u32) else {
                    break;
                };
                page_blocks.push((page_number, page_text));
            }
        }

        let (body, text_pages, stopped_after) = assemble_pages(page_blocks);
        if text_pages == 0 {
            return fail(
                crate::model_voice::PDF_NO_EXTRACTABLE_TEXT.to_string(),
                info.exit_code,
                info.duration_ms,
            );
        }

        let mut output = format!(
            "PDF: {} — pages {} of {}\n{}",
            request.path,
            request.pages.clone().unwrap_or_else(|| format!(
                "1-{}",
                total_pages
                    .map(|t| t.to_string())
                    .unwrap_or_else(|| "?".into())
            )),
            total_pages
                .map(|t| t.to_string())
                .unwrap_or_else(|| "?".into()),
            if pdfinfo_ok {
                render_info_line(&info.stdout)
            } else {
                "metadata unavailable (pdfinfo failed)".to_string()
            },
        );
        output.push_str(&body);
        if let Some(stopped) = stopped_after {
            let next = stopped + 1;
            let end = total_pages
                .map(|t| t.to_string())
                .unwrap_or_else(|| "?".into());
            output.push_str(&format!(
                "\n[read_pdf: stopped after page {stopped} (256 KB cap). Call again with pages=\"{next}-{end}\" to continue.]"
            ));
        }
        // The 4 MB harness capture cap would have cut pdftotext mid-stream;
        // surface that loudly rather than let a partial page pass as complete.
        if capture_cut {
            output.push_str("\n[read_pdf: poppler output exceeded the harness capture cap; the last page may be incomplete]");
        }

        Execution {
            stdout: output,
            stderr: if pdfinfo_ok {
                String::new()
            } else {
                info.stderr.clone()
            },
            exit_code: Some(0),
            duration_ms: start.elapsed().as_millis() as u64,
            raw_body: None,
        }
    }

    /// Failure rendering for the single-stage (hard error) and review path.
    pub fn failure_text(&self, exec: &Execution) -> String {
        format!(
            "read_pdf failed for {}\n{}\nexit code: {:?}",
            self.path, exec.stderr, exec.exit_code
        )
    }

    /// Validate the reviewed/submitted text: an empty submission would
    /// erase the extraction silently, so it is rejected outright.
    pub fn result(&self, text: String) -> Result<Value, String> {
        if text.trim().is_empty() {
            return Err(
                "Enter results, page content, or an explicit no-content/retrieval-error report."
                    .into(),
            );
        }
        Ok(json!({"path": self.path, "content": text}))
    }

    /// True when execution produced reviewable text.
    pub fn has_reviewable_text(&self, exec: &Execution) -> bool {
        exec.exit_code == Some(0) && !exec.stdout.trim().is_empty()
    }
}

/// Splicing of extracted pages into the reviewable body. Enforces the
/// global 256 KB budget at page boundaries: a page that does not fit ends
/// the output with an explicit continuation hint naming the next page to
/// request; a single over-budget first page is cut at a UTF-8 boundary.
/// Returns the body, the count of pages that actually carried text, and
/// the page to resume from when the budget cut the output.
fn assemble_pages(pages: Vec<(u32, String)>) -> (String, u32, Option<u32>) {
    let mut body = String::new();
    let mut text_pages = 0u32;
    let mut stopped_after = None;
    for (page_number, page_text) in pages {
        let page_block = format!("\n--- page {page_number} ---\n{page_text}");
        if body.len() + page_block.len() > MAX_PDF_TEXT_BYTES && !body.is_empty() {
            stopped_after = Some(page_number.saturating_sub(1));
            break;
        }
        if body.is_empty() && page_block.len() > MAX_PDF_TEXT_BYTES {
            let mut end = MAX_PDF_TEXT_BYTES;
            while !page_block.is_char_boundary(end) {
                end -= 1;
            }
            body.push_str(&page_block[..end]);
            body.push_str("\n[page truncated at 256 KB]\n");
            text_pages += 1;
            stopped_after = Some(page_number);
            break;
        }
        if !page_text.trim().is_empty() {
            text_pages += 1;
        }
        body.push_str(&page_block);
    }
    (body, text_pages, stopped_after)
}

fn canonical_pdf_path(path: &str) -> Result<String, String> {
    let candidate = Path::new(path);
    let full = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        PathBuf::from(crate::config::WORKSPACE_DIR.as_path()).join(candidate)
    };
    let canonical =
        std::fs::canonicalize(&full).map_err(|e| format!("cannot read {full:?}: {e}"))?;
    let meta =
        std::fs::metadata(&canonical).map_err(|e| format!("cannot stat {canonical:?}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{canonical:?} is not a regular file"));
    }
    if meta.len() > MAX_PDF_FILE_BYTES {
        return Err(format!(
            "{canonical:?} is {} bytes; the PDF size limit is {MAX_PDF_FILE_BYTES} bytes",
            meta.len()
        ));
    }
    // Magic bytes: the extension is irrelevant, the content decides.
    use std::io::Read;
    let mut magic = [0u8; 5];
    std::fs::File::open(&canonical)
        .and_then(|mut f| f.read_exact(&mut magic))
        .map_err(|e| format!("cannot read {canonical:?}: {e}"))?;
    if &magic != PDF_MAGIC {
        return Err(format!("{canonical:?} is not a PDF (missing %PDF header)"));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn checked_one_of(value: &str, allowed: &[&str], what: &str) -> Result<String, String> {
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("{what} must be one of {}", allowed.join(", ")))
    }
}

/// Validate the `pages` argument: comma-separated `N` or `A-B`, 1-based.
/// Bounds against the actual page count are checked at execution time,
/// once pdfinfo has told us how many pages the document has.
fn validate_pages(raw: &str) -> Result<(), String> {
    let parts: Vec<&str> = raw.split(',').collect();
    if parts.len() > MAX_PAGE_RANGES {
        return Err(format!(
            "at most {MAX_PAGE_RANGES} page ranges may be requested at once"
        ));
    }
    for part in parts {
        let (a, b) = match part.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (part.trim(), part.trim()),
        };
        let start: u32 = a
            .parse()
            .map_err(|_| format!("bad page number in pages={raw:?}"))?;
        let end: u32 = b
            .parse()
            .map_err(|_| format!("bad page number in pages={raw:?}"))?;
        if start == 0 {
            return Err("pages are 1-based; 0 is invalid".into());
        }
        if start > end {
            return Err(format!("page range {start}-{end} is reversed"));
        }
    }
    Ok(())
}

fn parse_pages(pdfinfo: &str) -> Option<u32> {
    pdfinfo.lines().find_map(|line| {
        line.trim_start()
            .strip_prefix("Pages:")
            .and_then(|v| v.trim().parse().ok())
    })
}

fn looks_like_password_failure(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("incorrect password")
}

fn field(pdfinfo: &str, name: &str) -> Option<String> {
    pdfinfo.lines().find_map(|line| {
        line.trim_start()
            .strip_prefix(name)
            .map(|v| v.trim().trim_start_matches(':').trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

fn file_size(path: &str) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// One-line metadata summary reused in the text-mode header.
fn render_info_line(pdfinfo: &str) -> String {
    let mut parts = Vec::new();
    if let Some(v) = field(pdfinfo, "Title:") {
        parts.push(format!("title: {v}"));
    }
    if let Some(v) = field(pdfinfo, "Producer:") {
        parts.push(format!("producer: {v}"));
    }
    if let Some(v) = field(pdfinfo, "Encrypted:") {
        parts.push(format!("encrypted: {v}"));
    }
    parts.join(" · ")
}

/// The `mode: "info"` body: a compact, self-describing metadata block.
fn render_info(
    path: &str,
    pdfinfo: &str,
    pdfinfo_ok: bool,
    stderr: &str,
    total: Option<u32>,
) -> String {
    if !pdfinfo_ok {
        return format!(
            "PDF: {path}\npdfinfo failed: {}\n",
            stderr.trim().lines().next().unwrap_or("unknown error")
        );
    }
    let mut lines = vec![format!("PDF: {path}")];
    for (label, key) in [
        ("title", "Title:"),
        ("author", "Author:"),
        ("pages", "Pages:"),
        ("page size", "Page size:"),
        ("producer", "Producer:"),
        ("encrypted", "Encrypted:"),
    ] {
        if let Some(v) = field(pdfinfo, key).or_else(|| {
            if key == "Pages:" {
                total.map(|t| t.to_string())
            } else {
                None
            }
        }) {
            lines.push(format!("{label}: {v}"));
        }
    }
    if let Some(size) = file_size(path) {
        lines.push(format!("file size: {size} bytes"));
    }
    lines.join("\n") + "\n"
}

/// poppler emits one `\f` after every page; the last segment is empty.
fn split_pages(text: &str) -> Vec<String> {
    text.split('\u{c}').map(|s| s.to_string()).collect()
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// poppler is a C++ parser for a hostile input format. When bubblewrap is
/// available, run it with a read-only filesystem view and no network. The
/// opt-out exists for systems where user namespaces are unavailable; the
/// direct path still has the timeout/output cap/process-group cleanup.
static POPPLER_SANDBOX: LazyLock<Option<PathBuf>> = LazyLock::new(|| {
    if std::env::var("PDF_NO_SANDBOX").ok().as_deref() == Some("1") {
        eprintln!("WARNING: PDF_NO_SANDBOX=1 — poppler is running without bubblewrap isolation");
        return None;
    }
    let candidate = find_in_path("bwrap")?;
    let canonical = std::fs::canonicalize(&candidate).ok()?;
    // Never execute a sandbox wrapper the agent can replace in its
    // workspace (for example when PATH contains ".").
    if canonical.starts_with(crate::config::WORKSPACE_DIR.as_path()) {
        eprintln!(
            "WARNING: ignoring workspace-local bwrap at {}; install bubblewrap outside the workspace",
            canonical.display()
        );
        return None;
    }
    Some(canonical)
});

async fn run_poppler(args: &[String], program: &Path) -> PopplerRun {
    let (wrapped_program, wrapped_args) = match POPPLER_SANDBOX.as_ref() {
        Some(bwrap) => {
            let mut argv: Vec<String> = vec![
                "--ro-bind".into(),
                "/".into(),
                "/".into(),
                "--dev".into(),
                "/dev".into(),
                "--proc".into(),
                "/proc".into(),
                "--unshare-net".into(),
                "--die-with-parent".into(),
                "--".into(),
                program.to_string_lossy().into_owned(),
            ];
            argv.extend(args.iter().cloned());
            (bwrap.as_path(), argv)
        }
        None => (program, args.to_vec()),
    };
    let captured = crate::tools::capture::run(
        wrapped_program,
        &wrapped_args,
        &crate::config::WORKSPACE_DIR,
        PDF_TIMEOUT,
        crate::config::MAX_TOOL_OUTPUT_BYTES,
    )
    .await;
    let spawn_error = captured.spawn_error.clone();
    let timed_out = captured.timed_out;
    let mut stderr = captured.stderr;
    if captured.timed_out {
        stderr = format!("timed out after {}s; {stderr}", PDF_TIMEOUT.as_secs());
    }
    PopplerRun {
        stdout: captured.stdout,
        stderr,
        exit_code: captured.exit_code,
        duration_ms: captured.duration_ms,
        timed_out,
        spawn_error,
    }
}

pub(crate) fn tool_infos() -> Vec<ToolInfo> {
    [json!({"type":"function", "function": {
        "name": READ,
        "description": crate::model_voice::PDF_DESCRIPTION,
        "parameters":{"type":"object","properties": {
            "path":{"type":"string","description": crate::model_voice::PDF_PATH},
            "pages":{"type":"string","description": crate::model_voice::PDF_PAGES},
            "layout":{"type":"string","enum":["reading","raw","layout"],"default":"reading","description": crate::model_voice::PDF_LAYOUT},
            "mode":{"type":"string","enum":["text","info"],"default":"text","description": crate::model_voice::PDF_MODE}
        }, "required":["path"], "additionalProperties":false}
    }})].into_iter().map(|v| serde_json::from_value(v).expect("read_pdf schema")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(args: Value) -> Result<PdfRequest, String> {
        PdfRequest::parse(READ, &args)
    }

    #[test]
    fn pages_must_be_well_formed() {
        for good in ["1", "1-3", "2,5-7,9", "10-10"] {
            validate_pages(good).unwrap();
        }
        for bad in [
            "0", "3-1", "a", "1-", "-3", "1..3", "1;2", "", "1-3-4", "1--3",
        ] {
            assert!(validate_pages(bad).is_err(), "{bad:?} should be rejected");
        }
        // A nonexistent file fails before pages are even consulted.
        let req = request(json!({"path": "definitely-missing.pdf", "pages": "3-1"}));
        assert!(req.is_err());
    }

    #[test]
    fn page_ranges_parse_from_raw() {
        let r = PdfRequest {
            kind: "pdf".into(),
            path: "x.pdf".into(),
            pages: Some("1-3,7,9-10".into()),
            layout: "reading".into(),
            mode: "text".into(),
            preview: None,
        };
        assert_eq!(r.ranges(Some(20)), vec![(1, 3), (7, 7), (9, 10)]);
        let full = PdfRequest { pages: None, ..r };
        assert_eq!(full.ranges(Some(33)), vec![(1, 33)]);
    }

    #[test]
    fn split_pages_counts_poppler_form_feeds() {
        // pdftotext terminates every page with \f; the trailing segment is empty.
        assert_eq!(split_pages("a\x0cb\x0c"), vec!["a", "b", ""]);
        assert_eq!(split_pages(""), vec![""]);
    }

    #[test]
    fn assemble_splices_pages_with_markers() {
        let pages = vec![(1, "alpha".to_string()), (2, "beta".to_string())];
        let (body, text_pages, stopped) = assemble_pages(pages);
        assert_eq!(text_pages, 2);
        assert_eq!(stopped, None);
        assert!(body.contains("--- page 1 ---"));
        assert!(body.contains("--- page 2 ---"));
        assert!(body.contains("alpha") && body.contains("beta"));
    }

    #[test]
    fn assemble_counts_image_only_pages_as_non_text() {
        let pages = vec![(1, "".to_string()), (2, "   ".to_string())];
        let (_, text_pages, stopped) = assemble_pages(pages);
        assert_eq!(text_pages, 0);
        assert_eq!(stopped, None);
    }

    #[test]
    fn assemble_stops_at_a_page_boundary_and_reports_resume_point() {
        // Force the budget path with synthetic pages: one huge page that
        // plus one more would exceed the cap.
        let big = "x".repeat(200 * 1024);
        let pages = vec![(1, big.clone()), (2, big.clone()), (3, "tail".to_string())];
        let (body, text_pages, stopped) = assemble_pages(pages);
        // Only page 1 fits the 256 KB budget; page 2 is cut at the boundary.
        assert_eq!(text_pages, 1);
        assert_eq!(stopped, Some(1));
        assert!(!body.contains("--- page 2 ---"));
        assert!(!body.contains("tail"));
        assert!(body.contains("--- page 1 ---"));
    }

    #[test]
    fn assemble_cuts_a_single_over_budget_page_instead_of_failing() {
        let huge = "y".repeat(300 * 1024);
        let pages = vec![(7, huge)];
        let (body, text_pages, stopped) = assemble_pages(pages);
        assert_eq!(text_pages, 1);
        assert_eq!(stopped, Some(7));
        assert!(
            body.len() <= MAX_PDF_TEXT_BYTES + 200,
            "single page cut at the cap"
        );
        assert!(body.contains("[page truncated at 256 KB]"));
    }

    #[test]
    fn unknown_modes_and_layouts_are_refused() {
        for (args, what) in [
            (json!({"path":"x.pdf","mode":"ocr"}), "mode"),
            (json!({"path":"x.pdf","layout":"grid"}), "layout"),
        ] {
            assert!(request(args).is_err(), "{what} should be refused");
        }
    }

    #[test]
    fn result_rejects_empty_submissions() {
        let r = PdfRequest {
            kind: "pdf".into(),
            path: "x.pdf".into(),
            pages: None,
            layout: "reading".into(),
            mode: "text".into(),
            preview: Some("kept text".into()),
        };
        assert!(r.result("   ".to_string()).is_err());
        assert_eq!(r.result("kept".to_string()).unwrap()["content"], "kept");
    }

    #[test]
    fn non_pdf_content_is_rejected_at_execution_not_parse_time() {
        let dir = std::env::temp_dir();
        let fake = dir.join(format!("not-a-pdf-{}.pdf", std::process::id()));
        std::fs::write(&fake, b"PK\x03\x04 definitely not a pdf").unwrap();
        // Parsing is deliberately filesystem-free; execution performs the
        // magic check after approval.
        let r = request(json!({"path": fake.to_string_lossy()})).unwrap();
        let err = r.resolved().unwrap_err();
        let _ = std::fs::remove_file(&fake);
        assert!(err.contains("not a PDF"), "{err}");
    }

    #[test]
    fn execution_accepts_content_is_pdf_with_any_extension() {
        let dir = std::env::temp_dir();
        let fixture = dir.join(format!("actually-a-pdf-{}.bin", std::process::id()));
        std::fs::write(&fixture, b"%PDF-1.4\nminimal").unwrap();
        let r = request(json!({"path": fixture.to_string_lossy()})).unwrap();
        let resolved = r.resolved().unwrap();
        let _ = std::fs::remove_file(&fixture);
        assert!(resolved.path.ends_with(".bin"));
    }

    #[test]
    fn missing_file_is_an_execution_error() {
        let missing =
            std::env::temp_dir().join(format!("does-not-exist-{}.pdf", std::process::id()));
        assert!(request(json!({"path": missing.to_string_lossy()})).is_ok());
        let r = request(json!({"path": missing.to_string_lossy()})).unwrap();
        assert!(r.resolved().is_err());
    }

    #[test]
    fn page_range_count_is_bounded() {
        let too_many = (1..=MAX_PAGE_RANGES + 1)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(validate_pages(&too_many).is_err());
    }
}
