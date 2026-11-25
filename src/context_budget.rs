//! One harness context-budget line.
//!
//! The fill is the latest request's prompt size divided by the resolved
//! window. The line is rewritten when the fill crosses 20, 40, 60, 80, 90,
//! or 96 percent. Wording lives in [`crate::model_voice`]. A published
//! provider window comes from the provider spec's `context_window`; an
//! Ollama model's live window comes from `num_ctx` in its parameters.

/// `num_ctx` from an Ollama `/api/show` parameters string.
///
/// The architecture `context_length` is the model maximum. The daemon's
/// live window is this parameter when the model sets it. A missing line
/// means the window was not reported.
pub(crate) fn num_ctx_from_parameters(parameters: &str) -> Option<u64> {
    for line in parameters.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() != Some("num_ctx") {
            continue;
        }
        let Some(value) = parts.next() else {
            continue;
        };
        if parts.next().is_some() {
            continue;
        }
        let Ok(count) = value.parse::<u64>() else {
            continue;
        };
        if count > 0 {
            return Some(count);
        }
    }
    None
}

/// Largest token count the pre-run dialog accepts.
pub(crate) const CONTEXT_GUIDE_MAX: u64 = 10_000_000;

/// A typed guide inside 1..=[`CONTEXT_GUIDE_MAX`].
pub(crate) fn accepted_guide(value: Option<u64>) -> Option<u64> {
    value.filter(|count| (1..=CONTEXT_GUIDE_MAX).contains(count))
}

/// Where the window number came from.
#[derive(Clone, Copy)]
pub(crate) enum BudgetSource {
    Provider,
    Guide,
}

impl BudgetSource {
    pub(crate) fn label(self) -> &'static str {
        match self {
            BudgetSource::Provider => "provider",
            BudgetSource::Guide => "guide",
        }
    }

    fn sentence(self) -> &'static str {
        match self {
            BudgetSource::Provider => crate::model_voice::CONTEXT_BUDGET_SOURCE_PROVIDER,
            BudgetSource::Guide => crate::model_voice::CONTEXT_BUDGET_SOURCE_GUIDE,
        }
    }
}

/// Highest mark reached by `used` tokens in a window of `window` tokens.
/// Zero means the run is still under 20%.
pub(crate) fn budget_mark(used: u64, window: u64) -> u16 {
    if window == 0 {
        return 0;
    }
    const MARKS: [u16; 6] = [20, 40, 60, 80, 90, 96];
    let mut reached = 0u16;
    for mark in MARKS {
        if (used as u128).saturating_mul(100) >= (window as u128) * u128::from(mark) {
            reached = mark;
        }
    }
    reached
}

pub(crate) fn budget_line(mark: u16, used: u64, window: u64, source: BudgetSource) -> String {
    let template = match mark {
        90 => crate::model_voice::CONTEXT_BUDGET_LINE_90,
        96 => crate::model_voice::CONTEXT_BUDGET_LINE_96,
        _ => crate::model_voice::CONTEXT_BUDGET_LINE,
    };
    let percent = if window == 0 {
        0
    } else {
        (used as u128).saturating_mul(100) / (window as u128)
    };
    let remaining = window.saturating_sub(used);
    template
        .replace("{used}", &used.to_string())
        .replace("{window}", &window.to_string())
        .replace("{percent}", &percent.to_string())
        .replace("{remaining}", &remaining.to_string())
        .replace("{source}", source.sentence())
}

/// Rewrite the kept line when `used` crosses a higher mark.
/// Returns whether the line changed.
pub(crate) fn advance_budget(
    mark: &mut u16,
    line: &mut Option<String>,
    used: u64,
    window: u64,
    source: BudgetSource,
) -> bool {
    let next = budget_mark(used, window);
    if next == 0 || next <= *mark {
        return false;
    }
    *mark = next;
    *line = Some(budget_line(next, used, window, source));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_budget_marks_follow_the_window() {
        assert_eq!(budget_mark(0, 0), 0);
        assert_eq!(budget_mark(19, 100), 0);
        assert_eq!(budget_mark(20, 100), 20);
        assert_eq!(budget_mark(39, 100), 20);
        assert_eq!(budget_mark(40, 100), 40);
        assert_eq!(budget_mark(80, 100), 80);
        assert_eq!(budget_mark(89, 100), 80);
        assert_eq!(budget_mark(90, 100), 90);
        assert_eq!(budget_mark(95, 100), 90);
        assert_eq!(budget_mark(96, 100), 96);
        assert_eq!(budget_mark(100, 100), 96);
        assert_eq!(budget_mark(150, 100), 96);
        assert_eq!(budget_mark(100_000, 500_000), 20);
        assert_eq!(budget_mark(99_999, 500_000), 0);
    }

    #[test]
    fn context_budget_num_ctx_reads_the_parameters_line() {
        let parameters =
            "num_ctx                        8192\nstop                           \"<|eot_id||>\"\n";
        assert_eq!(num_ctx_from_parameters(parameters), Some(8192));
        assert_eq!(num_ctx_from_parameters(""), None);
        assert_eq!(num_ctx_from_parameters("temperature 0.8"), None);
        assert_eq!(num_ctx_from_parameters("num_ctx 0"), None);
        assert_eq!(num_ctx_from_parameters("num_ctx no"), None);
        assert_eq!(num_ctx_from_parameters("num_ctx 8192 extra"), None);
        assert_eq!(num_ctx_from_parameters("llama.context_length 131072"), None);
    }

    #[test]
    fn context_budget_guide_accepts_a_positive_count() {
        assert_eq!(accepted_guide(None), None);
        assert_eq!(accepted_guide(Some(0)), None);
        assert_eq!(accepted_guide(Some(1)), Some(1));
        assert_eq!(
            accepted_guide(Some(CONTEXT_GUIDE_MAX)),
            Some(CONTEXT_GUIDE_MAX)
        );
        assert_eq!(accepted_guide(Some(CONTEXT_GUIDE_MAX + 1)), None);
    }

    #[test]
    fn context_budget_advance_keeps_one_line() {
        let mut mark = 0;
        let mut line = None;
        assert!(!advance_budget(
            &mut mark,
            &mut line,
            10,
            100,
            BudgetSource::Provider
        ));
        assert!(line.is_none());
        assert!(advance_budget(
            &mut mark,
            &mut line,
            25,
            100,
            BudgetSource::Provider
        ));
        assert_eq!(mark, 20);
        let first = line.clone().expect("20% line");
        assert!(!advance_budget(
            &mut mark,
            &mut line,
            30,
            100,
            BudgetSource::Provider
        ));
        assert_eq!(line.as_deref(), Some(first.as_str()));
        assert!(advance_budget(
            &mut mark,
            &mut line,
            97,
            100,
            BudgetSource::Guide
        ));
        assert_eq!(mark, 96);
        let second = line.expect("96% line");
        assert_ne!(first, second);
    }
}
