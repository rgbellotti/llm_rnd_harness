//! Model-response rendering: markdown-to-HTML conversion plus allowlist
//! sanitizing. Tool outputs never pass through here — they stay verbatim
//! text precisely so injected markup can't become live markup.

// Model-response HTML allowlist (rendered client-side). Deliberately small:
// lists, classic tables, links, basic inline code/text. No id/style,
// no script/style/iframe/img — ammonia strips those (script/style content
// included), so tool-output-shaped markup smuggled via prompt injection
// cannot become live markup. Class exceptions are Prism `language-*` on
// fenced code blocks and the math placeholders rendered locally by KaTeX.
const MODEL_HTML_TAGS: &[&str] = &[
    "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a", "b", "strong", "i", "em",
    "code", "pre", "br", "p", "span", "h1", "h2", "h3", "h4",
];

/// Prism language classes the sanitizer preserves on `code`/`pre`.
/// Mirrors the vendored components in `web/vendor/` (core covers
/// markup/css/clike/javascript; extras cover the rest). Unknown fence tags
/// render as plain code with no class.
const LANGUAGE_CLASSES: &[&str] = &[
    "language-rust",
    "language-javascript",
    "language-js",
    "language-markup",
    "language-html",
    "language-xml",
    "language-bash",
    "language-sh",
    "language-python",
    "language-mojo",
    "language-gdscript",
    "language-gd",
    "language-c",
    "language-cpp",
    "language-go",
    "language-odin",
    "language-clike",
    "language-css",
];

/// Normalize a fenced-code info string to a vendored Prism language.
/// Returns the canonical class suffix (without `language-`), or None for
/// unknown/empty tags (rendered as plain code).
fn normalize_code_lang(tag: &str) -> Option<&'static str> {
    match tag.trim().to_ascii_lowercase().as_str() {
        "rust" | "rs" => Some("rust"),
        "javascript" | "js" | "node" | "jsx" => Some("javascript"),
        "markup" | "html" | "xml" | "svg" => Some("markup"),
        "bash" | "sh" | "shell" | "zsh" => Some("bash"),
        "python" | "py" => Some("python"),
        "mojo" | "🔥" => Some("mojo"),
        "gdscript" | "gd" => Some("gdscript"),
        "c" | "h" => Some("c"),
        "cpp" | "c++" | "cc" | "cxx" | "hpp" => Some("cpp"),
        "go" | "golang" => Some("go"),
        "odin" => Some("odin"),
        _ => None,
    }
}

/// Render an escaped fenced block, with a Prism language class when known.
fn fenced_block(lang: Option<&str>, body: &str) -> String {
    match lang.and_then(normalize_code_lang) {
        Some(canonical) => format!(
            "<pre><code class=\"language-{canonical}\">{}</code></pre>\n",
            escape_html(body)
        ),
        None => format!("<pre><code>{}</code></pre>\n", escape_html(body)),
    }
}

pub(crate) fn raw_looks_like_html(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    MODEL_HTML_TAGS.iter().any(|t| {
        lower.contains(&format!("<{t}>"))
            || lower.contains(&format!("<{t} "))
            || lower.contains(&format!("<{t}/"))
    })
}

pub(crate) fn sanitize_model_html(raw: &str) -> String {
    // Note: `add_allowed_classes` alone whitelists `class` for the tag —
    // adding it via `add_tag_attributes` too panics in ammonia.
    // `Builder::empty()` clears tags but keeps ammonia's default URL
    // schemes (bitcoin, ftp, geo, irc, magnet...), so restrict them here:
    // the client sanitizer allows http/https/mailto only, and the
    // server-side content and the HTML exports should agree with it.
    ammonia::Builder::empty()
        .add_tags(MODEL_HTML_TAGS.iter().copied())
        .url_schemes(["http", "https", "mailto"].into_iter().collect())
        .add_allowed_classes("code", LANGUAGE_CLASSES)
        .add_allowed_classes("pre", LANGUAGE_CLASSES)
        .add_allowed_classes("p", &["math-display"])
        .add_allowed_classes("span", &["math-inline"])
        .clean(raw)
        .to_string()
}

/// Minimal HTML-escape for fenced code blocks and inline code spans.
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Inline markdown for model responses: `` `code` `` spans and `**bold**`.
/// Code spans are extracted first so `**` inside them is left alone.
/// Unmatched markers pass through as literal text.
fn parse_inline(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for (i, part) in s.split('`').enumerate() {
        if i % 2 == 1 {
            out.push_str("<code>");
            out.push_str(&escape_html(part));
            out.push_str("</code>");
        } else {
            out.push_str(&parse_inline_math(part));
        }
    }
    out
}

// A dollar is a delimiter only when unescaped and outside a $$ pair.
fn is_single_math_dollar(s: &str, at: usize) -> bool {
    let bytes = s.as_bytes();
    bytes[at] == b'$'
        && (at == 0 || bytes[at - 1] != b'$')
        && bytes.get(at + 1) != Some(&b'$')
        && bytes[..at]
            .iter()
            .rev()
            .take_while(|&&b| b == b'\\')
            .count()
            % 2
            == 0
}

fn parse_inline_math(s: &str) -> String {
    let mut out = String::new();
    let mut plain_start = 0;
    let mut cursor = 0;
    while cursor < s.len() {
        let rest = &s[cursor..];
        let pair = if let Some(after_open) = rest.strip_prefix("\\(") {
            after_open
                .find("\\)")
                .map(|close| (cursor + 2, cursor + 2 + close, 2))
        } else if is_single_math_dollar(s, cursor) {
            s[cursor + 1..]
                .char_indices()
                .find(|&(offset, ch)| ch == '$' && is_single_math_dollar(s, cursor + 1 + offset))
                .map(|(offset, _)| cursor + 1 + offset)
                // Reject currency pairs such as "$5 and $10". Spaces inside
                // "$ x $" remain valid for model-generated math.
                .filter(|&close| {
                    !s[close + 1..]
                        .chars()
                        .next()
                        .is_some_and(char::is_alphanumeric)
                })
                .map(|close| (cursor + 1, close, 1))
        } else {
            None
        };
        if let Some((start, end, delimiter_len)) = pair
            && !s[start..end].trim().is_empty()
        {
            out.push_str(&parse_bold(&s[plain_start..cursor]));
            out.push_str("<span class=\"math-inline\">");
            out.push_str(&escape_html(&s[start..end]));
            out.push_str("</span>");
            cursor = end + delimiter_len;
            plain_start = cursor;
        } else {
            cursor += rest.chars().next().unwrap().len_utf8();
        }
    }
    out.push_str(&parse_bold(&s[plain_start..]));
    out
}

fn parse_bold(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    loop {
        let Some(open) = rest.find("**") else {
            out.push_str(rest);
            break;
        };
        let after_open = &rest[open + 2..];
        let Some(close_rel) = after_open.find("**") else {
            out.push_str(rest);
            break;
        };
        let inner = &after_open[..close_rel];
        if inner.trim().is_empty() {
            out.push_str(rest);
            break;
        }
        out.push_str(&rest[..open]);
        out.push_str("<strong>");
        out.push_str(inner);
        out.push_str("</strong>");
        rest = &after_open[close_rel + 2..];
    }
    out
}

fn is_table_delimiter(line: &str) -> bool {
    let core: String = line
        .trim()
        .trim_matches(|c| c == '|' || c == ' ')
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    !core.is_empty() && core.contains('-') && core.chars().all(|c| c == '-' || c == ':' || c == '|')
}

fn split_row(line: &str) -> Vec<String> {
    line.trim()
        .trim_matches('|')
        .split('|')
        .map(|c| c.trim().to_string())
        .collect()
}

fn bullet_item(line: &str) -> Option<&str> {
    let t = line.trim_start();
    for m in ["* ", "- ", "+ "] {
        if let Some(rest) = t.strip_prefix(m) {
            return Some(rest.trim_start());
        }
    }
    None
}

fn ordered_item(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let rest = &t[digits..];
    rest.strip_prefix(". ")
        .or_else(|| rest.strip_prefix(") "))
        .map(str::trim_start)
}

fn heading_tag(line: &str) -> Option<(&str, &str)> {
    let t = line.trim_start();
    let hashes = t.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let inner = t[hashes..].strip_prefix(' ')?;
    Some((if hashes == 1 { "h3" } else { "h4" }, inner))
}

/// Convert common model-response markdown (bold, `#`/`##` headings, bullet
/// and numbered lists, pipe tables, inline code, fenced blocks) into the
/// allowlisted HTML subset. Lines that already look like HTML pass through
/// for ammonia to judge; anything unrecognized stays literal text.
/// Fenced blocks are never converted (so `#include` or `*ptr` in code
/// samples can't trigger headings or bullets).
pub(crate) fn markdown_to_html(raw: &str) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    let mut out = String::with_capacity(raw.len() + 64);
    let mut list: Option<&str> = None;
    let mut fence: Vec<&str> = Vec::new();
    let mut fence_lang: Option<String> = None;
    let mut in_fence = false;
    let mut i = 0;

    'lines: while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        // Fenced code blocks: verbatim, escaped, never converted.
        // The opening info string (```rust) selects a vendored Prism
        // language; unknown tags fall back to plain code.
        if trimmed.starts_with("```") {
            if let Some(tag) = list.take() {
                out.push_str(&format!("</{tag}>\n"));
            }
            if in_fence {
                out.push_str(&fenced_block(fence_lang.as_deref(), &fence.join("\n")));
                fence.clear();
                fence_lang = None;
                in_fence = false;
            } else {
                let info = trimmed.strip_prefix("```").unwrap_or("").trim();
                let first = info.split_whitespace().next().unwrap_or("");
                fence_lang = if first.is_empty() {
                    None
                } else {
                    Some(first.to_string())
                };
                in_fence = true;
            }
            i += 1;
            continue;
        }
        if in_fence {
            fence.push(line);
            i += 1;
            continue;
        }

        // Keep TeX display blocks intact across blank lines. The browser
        // renders these placeholders after the HTML allowlist is applied.
        let delimiter = match trimmed {
            "\\[" => Some("\\]"),
            "$$" => Some("$$"),
            _ => None,
        };
        if let Some(close) = delimiter {
            if let Some(end) = (i + 1..lines.len()).find(|&j| lines[j].trim() == close) {
                if let Some(tag) = list.take() {
                    out.push_str(&format!("</{tag}>\n"));
                }
                out.push_str("<p class=\"math-display\">");
                out.push_str(&escape_html(lines[i + 1..end].join("\n").trim()));
                out.push_str("</p>\n");
                i = end + 1;
                continue 'lines;
            }
        }
        for (open, close) in [("\\[", "\\]"), ("$$", "$$")] {
            if trimmed.starts_with(open)
                && trimmed.ends_with(close)
                && trimmed.len() > open.len() + close.len()
            {
                if let Some(tag) = list.take() {
                    out.push_str(&format!("</{tag}>\n"));
                }
                out.push_str("<p class=\"math-display\">");
                out.push_str(&escape_html(
                    trimmed[open.len()..trimmed.len() - close.len()].trim(),
                ));
                out.push_str("</p>\n");
                i += 1;
                continue 'lines;
            }
        }

        // Pipe tables: header row + delimiter row, then body rows.
        if line.contains('|') && i + 1 < lines.len() && is_table_delimiter(lines[i + 1]) {
            if let Some(tag) = list.take() {
                out.push_str(&format!("</{tag}>\n"));
            }
            let header = split_row(line);
            let ncols = header.len().max(1);
            out.push_str("<table>\n<thead>\n<tr>");
            for cell in &header {
                out.push_str("<th>");
                out.push_str(&parse_inline(cell));
                out.push_str("</th>");
            }
            out.push_str("</tr>\n</thead>\n<tbody>\n");
            i += 2;
            while i < lines.len() && lines[i].contains('|') && !lines[i].trim().is_empty() {
                let mut cells = split_row(lines[i]);
                cells.resize(ncols, String::new());
                out.push_str("<tr>");
                for cell in cells.iter().take(ncols) {
                    out.push_str("<td>");
                    out.push_str(&parse_inline(cell));
                    out.push_str("</td>");
                }
                out.push_str("</tr>\n");
                i += 1;
            }
            out.push_str("</tbody>\n</table>\n");
            continue;
        }

        if trimmed.is_empty() {
            if let Some(tag) = list.take() {
                out.push_str(&format!("</{tag}>\n"));
            }
            i += 1;
            continue;
        }

        if let Some((tag, inner)) = heading_tag(line) {
            if let Some(open) = list.take() {
                out.push_str(&format!("</{open}>\n"));
            }
            out.push_str(&format!("<{tag}>{}</{tag}>\n", parse_inline(inner)));
            i += 1;
            continue;
        }

        if let Some(item) = bullet_item(line) {
            if list != Some("ul") {
                if let Some(open) = list.take() {
                    out.push_str(&format!("</{open}>\n"));
                }
                out.push_str("<ul>\n");
                list = Some("ul");
            }
            out.push_str(&format!("<li>{}</li>\n", parse_inline(item)));
            i += 1;
            continue;
        }

        if let Some(item) = ordered_item(line) {
            if list != Some("ol") {
                if let Some(open) = list.take() {
                    out.push_str(&format!("</{open}>\n"));
                }
                out.push_str("<ol>\n");
                list = Some("ol");
            }
            out.push_str(&format!("<li>{}</li>\n", parse_inline(item)));
            i += 1;
            continue;
        }

        // Bare-HTML lines pass through for the sanitizer to judge.
        if trimmed.starts_with('<') {
            if let Some(tag) = list.take() {
                out.push_str(&format!("</{tag}>\n"));
            }
            out.push_str(line);
            out.push('\n');
            i += 1;
            continue;
        }

        if let Some(tag) = list.take() {
            out.push_str(&format!("</{tag}>\n"));
        }
        out.push_str(&format!("<p>{}</p>\n", parse_inline(line)));
        i += 1;
    }

    if in_fence && !fence.is_empty() {
        out.push_str(&fenced_block(fence_lang.as_deref(), &fence.join("\n")));
    }
    if let Some(tag) = list.take() {
        out.push_str(&format!("</{tag}>\n"));
    }
    out
}

#[cfg(test)]
mod markdown_tests {
    use super::*;

    #[test]
    fn bold_and_headings() {
        let md = "# Title\n\nSome **bold** and `code` text with ** gram ** kept.";
        let html = markdown_to_html(md);
        assert!(html.contains("<h3>Title</h3>"), "{html}");
        assert!(html.contains("<strong>bold</strong>"), "{html}");
        assert!(html.contains("<code>code</code>"), "{html}");
    }

    #[test]
    fn bullets_and_fences() {
        let md = "*   **Gram** is fast\n\n```c\n#include <stdio.h>\nint *ptr;\n```";
        let html = markdown_to_html(md);
        assert!(
            html.contains("<ul>") && html.contains("<li><strong>Gram</strong> is fast</li>"),
            "{html}"
        );
        assert!(html.contains("#include &lt;stdio.h&gt;"), "{html}");
        assert!(!html.contains("<h3>include"), "{html}");
        assert!(html.contains("<code class=\"language-c\">"), "{html}");
    }

    #[test]
    fn fence_language_aliases_and_unknown_fallback() {
        let html = markdown_to_html("```rs\nlet x = 1;\n```");
        assert!(html.contains("<code class=\"language-rust\">"), "{html}");
        let html = markdown_to_html("```js\nconsole.log(1)\n```");
        assert!(
            html.contains("<code class=\"language-javascript\">"),
            "{html}"
        );
        let html = markdown_to_html("```sh\necho hi\n```");
        assert!(html.contains("<code class=\"language-bash\">"), "{html}");
        let html = markdown_to_html("```odin\nmain :: proc() {}\n```");
        assert!(html.contains("<code class=\"language-odin\">"), "{html}");
        for lang in ["mojo", "Mojo", "🔥"] {
            let raw = format!("```{lang}\nfn main():\n    var x = 1\n```");
            let html = sanitize_model_html(&markdown_to_html(&raw));
            assert!(html.contains("<code class=\"language-mojo\">"), "{html}");
        }
        let html = markdown_to_html("```brainfuck\n+++\n```");
        assert!(html.contains("<pre><code>"), "{html}");
        assert!(!html.contains("language-"), "{html}");
    }

    #[test]
    fn sanitizer_keeps_language_class_only() {
        let clean =
            sanitize_model_html("<pre><code class=\"language-rust\">let x = 1;</code></pre>");
        assert!(clean.contains("language-rust"), "{clean}");
        let stripped =
            sanitize_model_html("<pre><code class=\"evil\" onclick=\"x()\">hi</code></pre>");
        assert!(!stripped.contains("evil"), "{stripped}");
        assert!(!stripped.contains("onclick"), "{stripped}");
    }

    #[test]
    fn latex_display_and_inline_survive_sanitizing() {
        let raw = "Dot product:\n\\[\n\n\\mathbf{a} \\cdot \\mathbf{b}=a_1b_1 + a_2b_2\n\n\\]\nAlso \\(a \\cdot b\\) works.";
        let html = sanitize_model_html(&markdown_to_html(raw));
        assert!(
            html.contains("class=\"math-display\">\\mathbf{a} \\cdot"),
            "{html}"
        );
        assert!(html.contains("class=\"math-inline\">a \\cdot b"), "{html}");
        assert!(!html.contains("<p>\\[</p>"), "{html}");
    }

    #[test]
    fn latex_in_code_or_unclosed_delimiters_stays_literal() {
        let html = markdown_to_html("`\\(a+b\\)`\n```text\n\\[\na+b\n\\]\n```\n\\[ unclosed");
        assert!(html.contains("<code>\\(a+b\\)</code>"), "{html}");
        assert!(
            html.contains("<pre><code>\\[\na+b\n\\]</code></pre>"),
            "{html}"
        );
        assert!(html.contains("<p>\\[ unclosed</p>"), "{html}");
        assert!(!html.contains("math-display"), "{html}");
    }

    #[test]
    fn single_dollar_math_renders_model_example_and_mixed_delimiters() {
        let raw = r"Solve for $ x $: $4 \times 5 = 20$, $20 + 33 = 53$, then $\boxed{53}$. Also \(y\), **bold**, and $α < β$.";
        let html = sanitize_model_html(&markdown_to_html(raw));
        for math in [
            " x ",
            r"4 \times 5 = 20",
            "20 + 33 = 53",
            r"\boxed{53}",
            "y",
            "α &lt; β",
        ] {
            assert!(
                html.contains(&format!("<span class=\"math-inline\">{math}</span>")),
                "{html}"
            );
        }
        assert!(html.contains("<strong>bold</strong>"), "{html}");
    }

    #[test]
    fn dollar_currency_escapes_code_and_unmatched_markers_stay_literal() {
        for raw in [
            r"Costs $5 and $10.",
            r"Costs $5.00, $10.00, and $20.",
            r"Escaped \$x\$.",
            r"Unclosed $x",
            r"Empty $ $",
            r"Embedded $$x$$",
        ] {
            let html = markdown_to_html(raw);
            assert!(!html.contains("math-inline"), "{raw}: {html}");
            assert!(html.contains(raw), "{html}");
        }
        let html = markdown_to_html("`$x$`\n```tex\n$\\boxed{53}$\n```");
        assert!(html.contains("<code>$x$</code>"), "{html}");
        assert!(html.contains("$\\boxed{53}$"), "{html}");
        assert!(!html.contains("math-inline"), "{html}");
        let html = markdown_to_html(r"Costs $5 and $10; solve $x + 1$ instead.");
        assert!(
            html.contains("Costs $5 and $10; solve <span class=\"math-inline\">x + 1</span>"),
            "{html}"
        );
    }

    #[test]
    fn dollar_display_math_keeps_display_mode() {
        for raw in ["$$x + 1$$", "$$\nx + 1\n$$"] {
            let html = sanitize_model_html(&markdown_to_html(raw));
            assert!(
                html.contains("<p class=\"math-display\">x + 1</p>"),
                "{html}"
            );
            assert!(!html.contains("math-inline"), "{html}");
        }
    }

    #[test]
    fn pipe_table_with_alignment_row() {
        let md = "| Editor | Appeal |\n| :--- | :--- |\n| **Neovim** | Fast. |\n| Zed | Snappy. |";
        let html = markdown_to_html(md);
        assert!(
            html.contains("<table>") && html.contains("<th>Editor</th>"),
            "{html}"
        );
        assert!(html.contains("<td><strong>Neovim</strong>"), "{html}");
        assert!(!html.contains(':') || !html.contains("---"), "{html}");
        let clean = sanitize_model_html(&html);
        assert!(clean.contains("<table>"), "{clean}");
    }

    #[test]
    fn unmatched_markers_stay_literal() {
        let html = markdown_to_html("a * b and 5 > 3 with **open end");
        assert!(
            !html.contains("<ul>") && !html.contains("<strong>"),
            "{html}"
        );
    }

    #[test]
    fn links_outside_the_safe_schemes_do_not_survive_sanitizing() {
        // ammonia's defaults admit bitcoin, ftp, geo, irc and more;
        // the server side must agree with the client sanitizer
        // (http/https/mailto only).
        let html = r#"<a href="ftp://example.com/file">ftp</a>
<a href="geo:52.1,4.5">geo</a>
<a href="https://example.com/page">https</a>
<a href="mailto:someone@example.com">mailto</a>"#;
        let clean = sanitize_model_html(html);
        assert!(clean.contains("https://example.com/page"), "{clean}");
        assert!(clean.contains("mailto:someone@example.com"), "{clean}");
        assert!(!clean.contains("ftp://"), "{clean}");
        assert!(!clean.contains("geo:"), "{clean}");
        // The refused links keep their text but lose the href.
        assert!(clean.contains("ftp</a>"), "{clean}");
        assert!(clean.contains("geo</a>"), "{clean}");
    }
}
