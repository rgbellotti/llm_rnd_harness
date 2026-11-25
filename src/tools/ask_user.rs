//! Structured questions and notes, answered through the approval dialog.
use ollama_rs::generation::tools::ToolInfo;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub(crate) const TOOL_NAME: &str = "ask_user";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UserInteraction {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub message: String,
    pub questions: Vec<Question>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Question {
    pub id: String,
    pub question: String,
    pub options: Vec<OptionChoice>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OptionChoice {
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub recommended: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UserAnswer {
    pub id: String,
    /// Zero-based option index; null means the user's literal Other answer.
    pub choice: Option<usize>,
    #[serde(default)]
    pub text: String,
}

impl UserInteraction {
    pub fn parse(args: &Value) -> Result<Self, String> {
        let request: Self = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
        if !matches!(request.kind.as_str(), "question" | "note") {
            return Err("kind must be question or note".into());
        }
        if request.title.trim().is_empty() || !(1..=5).contains(&request.questions.len()) {
            return Err("provide a title and 1–5 questions".into());
        }
        let mut ids = HashSet::new();
        for question in &request.questions {
            if question.id.trim().is_empty() || !ids.insert(&question.id) {
                return Err("question IDs must be non-empty and unique".into());
            }
            if question.question.trim().is_empty() || !(1..=6).contains(&question.options.len()) {
                return Err("each question needs text and 1–6 options".into());
            }
            let mut labels = HashSet::new();
            for option in &question.options {
                let shown = option.label.trim();
                let label = shown.to_lowercase();
                if label.is_empty() {
                    return Err("each option needs a non-empty label".into());
                }
                if label.starts_with("other") {
                    return Err(format!(
                        "option label \"{shown}\" is reserved. \"other\" and any labels that begin with \"other\" are reserved, in any case."
                    ));
                }
                if !labels.insert(label) {
                    return Err(format!(
                        "option label \"{shown}\" is repeated. Labels must be unique."
                    ));
                }
            }
            if question.options.iter().filter(|o| o.recommended).count() > 1 {
                return Err("mark at most one recommended option per question".into());
            }
        }
        Ok(request)
    }

    /// Validate against the actual pending request, not client-supplied labels.
    /// Keep literal text intact, including leading/trailing whitespace.
    pub fn answer(&self, answers: &[UserAnswer]) -> Result<Value, String> {
        if answers.len() != self.questions.len() {
            return Err("answer every question".into());
        }
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for question in &self.questions {
            let answer = answers
                .iter()
                .find(|a| a.id == question.id)
                .ok_or_else(|| format!("missing answer for {}", question.id))?;
            if !seen.insert(&answer.id) {
                return Err("duplicate answer ID".into());
            }
            let (source, text) = match answer.choice {
                Some(index) => {
                    if !answer.text.is_empty() {
                        return Err("option answers cannot also supply Other text".into());
                    }
                    let option = question.options.get(index).ok_or("invalid option index")?;
                    ("option", option.label.clone())
                }
                None => {
                    if answer.text.trim().is_empty() {
                        return Err("Other answers need text".into());
                    }
                    ("other", answer.text.clone())
                }
            };
            result.push(serde_json::json!({
                "id": question.id, "question": question.question,
                "source": source, "choice": answer.choice, "answer": text,
            }));
        }
        Ok(serde_json::json!({ "kind": self.kind, "title": self.title, "answers": result }))
    }
}

pub(crate) fn tool_info() -> ToolInfo {
    serde_json::from_value(serde_json::json!({
        "type": "function", "function": {
            "name": TOOL_NAME,
            "description": crate::model_voice::ASK_USER_DESCRIPTION,
            "parameters": { "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["question", "note"] },
                "title": { "type": "string" },
                "message": { "type": "string", "description": crate::model_voice::ASK_USER_MESSAGE },
                "questions": { "type": "array", "minItems": 1, "maxItems": 5,
                    "items": { "type": "object", "properties": {
                        "id": { "type": "string", "description": crate::model_voice::ASK_USER_ID },
                        "question": { "type": "string" },
                        "options": { "type": "array", "minItems": 1, "maxItems": 6,
                            "items": { "type": "object", "properties": {
                                "label": { "type": "string", "description": crate::model_voice::ASK_USER_LABEL },
                                "description": { "type": "string" },
                                "recommended": { "type": "boolean" }
                            }, "required": ["label"], "additionalProperties": false }
                        }
                    }, "required": ["id", "question", "options"], "additionalProperties": false }
                }
            }, "required": ["kind", "title", "questions"], "additionalProperties": false }
        }
    })).expect("ask_user tool schema must deserialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn sample() -> Value {
        serde_json::json!({"kind": "note", "title": "Storage choice", "message": "Choose before proceeding.",
        "questions": [
            {"id": "storage", "question": "Where should data live?", "options": [
                {"label": "Local", "recommended": true}, {"label": "Remote"}]},
            {"id": "risk", "question": "Proceed?", "options": [{"label": "Reconsider"}]}
        ]})
    }

    #[test]
    fn returns_selected_labels_and_literal_other_in_question_order() {
        let request = UserInteraction::parse(&sample()).unwrap();
        let literal = "  Keep my \\path\nand <literal> text  ";
        let answer = request
            .answer(&[
                UserAnswer {
                    id: "risk".into(),
                    choice: None,
                    text: literal.into(),
                },
                UserAnswer {
                    id: "storage".into(),
                    choice: Some(1),
                    text: String::new(),
                },
            ])
            .unwrap();
        assert_eq!(answer["answers"][0]["answer"], "Remote");
        assert_eq!(answer["answers"][1]["answer"], literal);
        assert_eq!(answer["answers"][1]["source"], "other");
    }

    #[test]
    fn rejects_missing_duplicate_unknown_and_out_of_range_answers() {
        let request = UserInteraction::parse(&sample()).unwrap();
        let answer = |id: &str, choice, text: &str| UserAnswer {
            id: id.into(),
            choice,
            text: text.into(),
        };
        assert!(request.answer(&[]).is_err());
        assert!(
            request
                .answer(&[
                    answer("storage", Some(0), ""),
                    answer("storage", Some(0), "")
                ])
                .is_err()
        );
        assert!(
            request
                .answer(&[
                    answer("storage", Some(0), ""),
                    answer("unknown", Some(0), "")
                ])
                .is_err()
        );
        assert!(
            request
                .answer(&[answer("storage", Some(2), ""), answer("risk", Some(0), "")])
                .is_err()
        );
        assert!(
            request
                .answer(&[answer("storage", None, " \n "), answer("risk", Some(0), "")])
                .is_err()
        );
        assert!(
            request
                .answer(&[
                    answer("storage", Some(0), "forged label"),
                    answer("risk", Some(0), "")
                ])
                .is_err()
        );
    }

    #[test]
    fn rejects_unusable_requests_and_multiple_recommendations() {
        let mut args = sample();
        args["questions"][1]["id"] = "storage".into();
        assert!(UserInteraction::parse(&args).is_err());
        args = sample();
        args["questions"][0]["options"][1]["recommended"] = true.into();
        assert!(UserInteraction::parse(&args).is_err());
        args = sample();
        args["questions"][0]["options"][1]["label"] = "Other".into();
        assert!(UserInteraction::parse(&args).is_err());
        args = sample();
        args["questions"] = serde_json::json!([]);
        assert!(UserInteraction::parse(&args).is_err());
        let info = tool_info();
        let wire = serde_json::to_value(info).unwrap();
        assert_eq!(wire["function"]["name"], TOOL_NAME);
    }
}
