//! The "decision" query engine: run a discrete decision (bool, rating,
//! or choice) against an Ollama *decision model* — a local `d3`-family
//! tag or a cloud `clef` tag. Decision models are a distinct capability:
//! they do not answer `/api/chat`; they answer the daemon's `/v1/systemone`
//! endpoint, which takes a shared `state` (the text to evaluate) and one
//! or more structured `questions`.
//!
//! A decision query is transient: it is never recorded in history and it
//! does not touch the run semaphore, so it can run while a [Generate] run
//! is in flight (including during an approval window).

use ollama_rs::Ollama;
use serde_json::{Value, json};

/// The shape of one decision question, as the operator expresses it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DecisionKind {
    Bool,
    Rating { min: i64, max: i64 },
    Choice { options: Vec<String> },
}

impl DecisionKind {
    pub(crate) fn label(&self) -> &'static str {
        match self {
            DecisionKind::Bool => "bool",
            DecisionKind::Rating { .. } => "rating",
            DecisionKind::Choice { .. } => "choice",
        }
    }
}

/// What one decision query produced.
pub(crate) struct DecisionResult {
    pub model: String,
    pub raw: String,
    /// The coerced decision, when the answer could be read.
    pub value: Option<Value>,
    /// True when the answer was read as the requested type.
    pub parsed_ok: bool,
}

/// A single-letter option key (`a`, `b`, …) for a choice index. The
/// renderer maps each option to a single token; letters are the compact
/// code the CLI's `--choice key=…` convention uses. Callers cap options
/// at 26 before this runs.
fn option_key(index: usize) -> String {
    ((b'a' + index as u8) as char).to_string()
}

fn option_by_key<'a>(options: &'a [String], key: &str) -> Option<&'a str> {
    let index = key.bytes().next().map(|byte| (byte.wrapping_sub(b'a')) as usize);
    index.and_then(|index| options.get(index).map(|option| option.as_str()))
}

/// The per-question instruction. Cloud `clef` decision models require it;
/// local `d3` models accept it. The statement being evaluated is the shared
/// `state`; this tells the model what to decide about it.
fn instructions(kind: &DecisionKind) -> &'static str {
    match kind {
        DecisionKind::Bool => "Evaluate the statement as true or false.",
        DecisionKind::Rating { .. } => "Rate the statement on the given scale.",
        DecisionKind::Choice { .. } => "Choose the single best option for the statement.",
    }
}

/// Build the `/v1/systemone` request body for one question.
fn systemone_body(model: &str, kind: &DecisionKind, state: &str) -> Value {
    let question = match kind {
        DecisionKind::Bool => json!({ "type": "noul", "instructions": instructions(kind) }),
        DecisionKind::Rating { min, max } => {
            let levels: Vec<String> = (*min..=*max).map(|level| level.to_string()).collect();
            json!({ "type": "score", "criteria": levels, "instructions": instructions(kind) })
        }
        DecisionKind::Choice { options } => {
            let mut criteria = serde_json::Map::new();
            for (index, option) in options.iter().enumerate() {
                criteria.insert(option_key(index), Value::String(option.clone()));
            }
            json!({ "type": "choice", "criteria": criteria, "instructions": instructions(kind) })
        }
    };
    json!({
        "model": model,
        "state": state,
        "questions": { "q1": question },
    })
}

/// Run one decision query against the model's `/v1/systemone` endpoint.
pub(crate) async fn run_decision(
    ollama: &Ollama,
    model: &str,
    kind: &DecisionKind,
    state: &str,
) -> Result<DecisionResult, String> {
    let body = systemone_body(model, kind, state);
    let response = crate::providers::ollama::send_systemone(ollama, &body).await?;
    let answer = response.get("answers").and_then(|answers| answers.get("q1"));
    let (value, parsed_ok, raw) = match answer {
        Some(answer) => read_answer(kind, answer),
        None => (
            None,
            false,
            serde_json::to_string_pretty(&response).unwrap_or_default(),
        ),
    };
    Ok(DecisionResult {
        model: model.to_string(),
        raw,
        value,
        parsed_ok,
    })
}

/// Read one answer back into the requested type and a readable summary.
fn read_answer(kind: &DecisionKind, answer: &Value) -> (Option<Value>, bool, String) {
    match kind {
        DecisionKind::Bool => match answer.get("noul").and_then(|value| value.as_f64()) {
            Some(confidence) => {
                let yes = confidence >= 0.5;
                let raw = format!("confidence {confidence:.3} — {}", if yes { "yes" } else { "no" });
                (Some(Value::Bool(yes)), true, raw)
            }
            None => (
                None,
                false,
                serde_json::to_string_pretty(answer).unwrap_or_default(),
            ),
        },
        DecisionKind::Rating { min, max } => {
            match answer.get("score").and_then(|value| value.as_f64()) {
                Some(score) => {
                    let mut raw = format!("score {score:.3} on a {min}–{max} scale");
                    if let Some(confidence) = answer.get("confidence").and_then(|value| value.as_f64())
                    {
                        raw.push_str(&format!(" (confidence {confidence:.3})"));
                    }
                    (Some(Value::from(score)), true, raw)
                }
                None => (
                    None,
                    false,
                    serde_json::to_string_pretty(answer).unwrap_or_default(),
                ),
            }
        }
        DecisionKind::Choice { options } => {
            match answer.get("choice").and_then(|value| value.as_str()) {
                Some(key) => {
                    let label = option_by_key(options, key).unwrap_or(key);
                    let mut raw = label.to_string();
                    if let Some(confidence) = answer.get("confidence").and_then(|value| value.as_f64())
                    {
                        raw.push_str(&format!(" (confidence {confidence:.3})"));
                    }
                    if let Some(probabilities) = answer.get("probabilities").and_then(|value| value.as_object())
                    {
                        let parts: Vec<String> = probabilities
                            .iter()
                            .map(|(key, value)| {
                                let label = option_by_key(options, key).unwrap_or(key.as_str());
                                format!("{label} {:.3}", value.as_f64().unwrap_or(0.0))
                            })
                            .collect();
                        if !parts.is_empty() {
                            raw.push_str(&format!("; probabilities: {}", parts.join(", ")));
                        }
                    }
                    (Some(Value::String(label.to_string())), true, raw)
                }
                None => (
                    None,
                    false,
                    serde_json::to_string_pretty(answer).unwrap_or_default(),
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bool_kind() -> DecisionKind {
        DecisionKind::Bool
    }

    fn rating_kind() -> DecisionKind {
        DecisionKind::Rating { min: 1, max: 5 }
    }

    fn choice_kind() -> DecisionKind {
        DecisionKind::Choice {
            options: vec!["Local".into(), "Remote".into(), "Hybrid".into()],
        }
    }

    #[test]
    fn systemone_body_shapes_each_kind() {
        let body = systemone_body("d3:4b", &bool_kind(), "the sky is blue");
        assert_eq!(body["model"], "d3:4b");
        assert_eq!(body["state"], "the sky is blue");
        assert_eq!(body["questions"]["q1"]["type"], "noul");

        let rating = systemone_body("d3:4b", &rating_kind(), "rate it");
        assert_eq!(
            rating["questions"]["q1"]["criteria"],
            serde_json::json!(["1", "2", "3", "4", "5"])
        );

        let choice = systemone_body("d3:4b", &choice_kind(), "pick");
        assert_eq!(choice["questions"]["q1"]["type"], "choice");
        assert_eq!(
            choice["questions"]["q1"]["criteria"]["a"],
            serde_json::json!("Local")
        );
        assert_eq!(
            choice["questions"]["q1"]["criteria"]["c"],
            serde_json::json!("Hybrid")
        );
    }

    #[test]
    fn option_keys_are_single_letters_and_map_back() {
        let options = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(option_key(0), "a");
        assert_eq!(option_key(25), "z");
        assert_eq!(option_by_key(&options, "b"), Some("b"));
        assert_eq!(option_by_key(&options, "z"), None);
    }

    #[test]
    fn bool_answer_thresholds_to_true_or_false() {
        let (value, ok, _) = read_answer(&bool_kind(), &serde_json::json!({ "type": "noul", "noul": 0.967 }));
        assert_eq!(value, Some(Value::Bool(true)));
        assert!(ok);
        let (value, ok, _) = read_answer(&bool_kind(), &serde_json::json!({ "type": "noul", "noul": 0.12 }));
        assert_eq!(value, Some(Value::Bool(false)));
        assert!(ok);
    }

    #[test]
    fn score_answer_reads_the_float() {
        let (value, ok, raw) = read_answer(&rating_kind(), &serde_json::json!({ "type": "score", "score": 2.131 }));
        assert_eq!(value, Some(serde_json::json!(2.131)));
        assert!(ok);
        assert!(raw.contains("1–5"), "{raw}");
    }

    #[test]
    fn choice_answer_maps_the_key_back_to_a_label() {
        let (value, ok, raw) = read_answer(
            &choice_kind(),
            &serde_json::json!({
                "type": "choice", "choice": "b", "confidence": 0.4,
                "probabilities": { "a": 0.2, "b": 0.4, "c": 0.4 }
            }),
        );
        assert_eq!(value, Some(Value::String("Remote".into())));
        assert!(ok);
        assert!(raw.contains("Remote"), "{raw}");
        assert!(raw.contains("Local"), "{raw}");
    }

    #[test]
    fn an_unreadable_answer_keeps_the_raw_json() {
        let (value, ok, raw) = read_answer(&bool_kind(), &serde_json::json!({ "type": "noul" }));
        assert_eq!(value, None);
        assert!(!ok);
        assert!(raw.contains("\"noul\""), "{raw}");
    }
}
