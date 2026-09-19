//! MCP elicitation: a server asking the user for a few values, or asking them
//! to visit a page.
//!
//! Only the shapes the MCP specification defines for elicitation are shown:
//! a flat object of strings, numbers, booleans and string enums, or a single
//! http(s) address. Anything richer stays declinable only, because turning
//! an unknown form into "accept" could hand a server values the user never
//! saw. Every accepted answer is checked here against the schema the server
//! sent, not trusted from the window.

use serde_json::{Map, Value};

const MAX_FIELDS: usize = 20;
const MAX_ENUM_VALUES: usize = 50;
const MAX_STRING_BYTES: usize = 4096;
const MAX_URL_BYTES: usize = 2048;
const STRING_FORMATS: [&str; 4] = ["email", "uri", "date", "date-time"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    /// Codex's own MCP tool-call approval: an empty, tagged form.
    ToolApproval,
    /// A form the chat window can draw and this module can check.
    Form,
    /// A page the user is asked to open.
    Url,
    Unsupported,
}

impl Kind {
    pub(super) fn card_name(self) -> &'static str {
        match self {
            Kind::ToolApproval => "mcp_tool",
            Kind::Form => "mcp_form",
            Kind::Url => "mcp_url",
            Kind::Unsupported => "unsupported_input",
        }
    }
}

pub(super) fn kind(params: &Value) -> Kind {
    if is_tool_approval(params) {
        return Kind::ToolApproval;
    }
    match params["mode"].as_str() {
        Some("url") if params["url"].as_str().is_some_and(is_web_url) => Kind::Url,
        // `mode` is optional in the first elicitation revision; a form is
        // what it meant then.
        Some("form") | None if supported_schema(&params["requestedSchema"]) => Kind::Form,
        _ => Kind::Unsupported,
    }
}

// Codex's MCP tool approval is an empty form with an explicit semantic tag.
// Never turn a login form or another structured input into a generic Yes.
fn is_tool_approval(params: &Value) -> bool {
    let meta = params.get("_meta").or_else(|| params.get("meta"));
    params["mode"] == "form"
        && meta
            .and_then(|meta| meta.get("codex_approval_kind"))
            .and_then(Value::as_str)
            == Some("mcp_tool_call")
        && params["requestedSchema"] == serde_json::json!({"type": "object", "properties": {}})
}

fn is_web_url(url: &str) -> bool {
    url.len() <= MAX_URL_BYTES
        && (url.starts_with("https://") || url.starts_with("http://"))
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && url.split_once("://").is_some_and(|(_, rest)| {
            !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with('@')
        })
}

fn supported_schema(schema: &Value) -> bool {
    let Some(properties) = schema["properties"].as_object() else {
        return false;
    };
    if schema["type"] != "object" || properties.is_empty() || properties.len() > MAX_FIELDS {
        return false;
    }
    let required_ok = match schema.get("required") {
        None => true,
        Some(Value::Array(names)) => names.iter().all(|name| {
            name.as_str()
                .is_some_and(|name| properties.contains_key(name))
        }),
        Some(_) => false,
    };
    required_ok && properties.values().all(supported_field)
}

fn supported_field(field: &Value) -> bool {
    match field["type"].as_str() {
        Some("string") => {
            let format_ok = field
                .get("format")
                .is_none_or(|format| format.as_str().is_some_and(|f| STRING_FORMATS.contains(&f)));
            let enum_ok = field.get("enum").is_none_or(|values| {
                values.as_array().is_some_and(|values| {
                    !values.is_empty()
                        && values.len() <= MAX_ENUM_VALUES
                        && values.iter().all(Value::is_string)
                })
            });
            format_ok && enum_ok
        }
        Some("number" | "integer" | "boolean") => true,
        _ => false,
    }
}

/// The `result` for an elicitation answer. `answer` is the JSON object the
/// user filled in, required only when accepting a form.
pub(super) fn result(params: &Value, allow: bool, answer: Option<&str>) -> Result<Value, String> {
    if !allow {
        return Ok(serde_json::json!({"action": "decline", "content": null}));
    }
    match kind(params) {
        Kind::ToolApproval => Ok(serde_json::json!({"action": "accept", "content": {}})),
        Kind::Url => Ok(serde_json::json!({"action": "accept"})),
        Kind::Form => {
            let raw = answer.ok_or("Fill in the form first.")?;
            if raw.len() > MAX_FIELDS * (MAX_STRING_BYTES + 64) {
                return Err("The answer is too long.".to_string());
            }
            let supplied: Value = serde_json::from_str(raw).map_err(|_| "Invalid answer.")?;
            let content = checked_content(&params["requestedSchema"], &supplied)?;
            Ok(serde_json::json!({"action": "accept", "content": content}))
        }
        Kind::Unsupported => Err("This input format is not supported yet.".to_string()),
    }
}

fn checked_content(schema: &Value, supplied: &Value) -> Result<Value, String> {
    let supplied = supplied.as_object().ok_or("Invalid answer.")?;
    let properties = schema["properties"].as_object().ok_or("Invalid form.")?;
    if let Some(unknown) = supplied.keys().find(|key| !properties.contains_key(*key)) {
        return Err(format!("The form has no field named {unknown}."));
    }
    let required: Vec<&str> = schema["required"]
        .as_array()
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut content = Map::new();
    for (name, field) in properties {
        match supplied.get(name) {
            None | Some(Value::Null) => {
                if required.contains(&name.as_str()) {
                    return Err(format!("{} is required.", label(name, field)));
                }
            }
            Some(value) => {
                check_value(name, field, value)?;
                content.insert(name.clone(), value.clone());
            }
        }
    }
    Ok(Value::Object(content))
}

fn label<'a>(name: &'a str, field: &'a Value) -> &'a str {
    field["title"].as_str().unwrap_or(name)
}

fn check_value(name: &str, field: &Value, value: &Value) -> Result<(), String> {
    let label = label(name, field);
    match field["type"].as_str() {
        Some("string") => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{label} must be text."))?;
            if text.len() > MAX_STRING_BYTES {
                return Err(format!("{label} is too long."));
            }
            if let Some(values) = field["enum"].as_array() {
                if !values.iter().any(|allowed| allowed == value) {
                    return Err(format!("{label} must be one of the listed choices."));
                }
            }
            let length = text.chars().count() as u64;
            if field["minLength"].as_u64().is_some_and(|min| length < min)
                || field["maxLength"].as_u64().is_some_and(|max| length > max)
            {
                return Err(format!("{label} has the wrong length."));
            }
            Ok(())
        }
        Some(kind @ ("number" | "integer")) => {
            let number = value
                .as_f64()
                .ok_or_else(|| format!("{label} must be a number."))?;
            if kind == "integer" && !(value.is_i64() || value.is_u64()) {
                return Err(format!("{label} must be a whole number."));
            }
            if field["minimum"].as_f64().is_some_and(|min| number < min)
                || field["maximum"].as_f64().is_some_and(|max| number > max)
            {
                return Err(format!("{label} is out of range."));
            }
            Ok(())
        }
        Some("boolean") if value.is_boolean() => Ok(()),
        Some("boolean") => Err(format!("{label} must be yes or no.")),
        _ => Err(format!("{label} cannot be answered here.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn form() -> Value {
        json!({
            "mode": "form",
            "message": "Which repository?",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "title": "Repository", "maxLength": 100},
                    "branch": {"type": "string", "enum": ["main", "dev"]},
                    "depth": {"type": "integer", "minimum": 1, "maximum": 50},
                    "force": {"type": "boolean"}
                },
                "required": ["repo"]
            }
        })
    }

    #[test]
    fn kinds_are_told_apart() {
        assert_eq!(kind(&form()), Kind::Form);
        assert_eq!(
            kind(&json!({"mode": "url", "url": "https://example.com/login", "elicitationId": "e"})),
            Kind::Url
        );
        assert_eq!(
            kind(
                &json!({"mode": "form", "_meta": {"codex_approval_kind": "mcp_tool_call"}, "requestedSchema": {"type": "object", "properties": {}}})
            ),
            Kind::ToolApproval
        );
        for unsupported in [
            json!({"mode": "url", "url": "javascript:alert(1)"}),
            json!({"mode": "url", "url": "https:///nohost"}),
            json!({"mode": "form", "requestedSchema": {"type": "object", "properties": {}}}),
            json!({"mode": "form", "requestedSchema": {"type": "object", "properties": {"nested": {"type": "object"}}}}),
            json!({"mode": "form", "requestedSchema": {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["missing"]}}),
            json!({"mode": "something-new"}),
        ] {
            assert_eq!(kind(&unsupported), Kind::Unsupported, "{unsupported}");
        }
    }

    #[test]
    fn an_accepted_form_carries_only_checked_values() {
        let answer = r#"{"repo":"lattice","branch":"dev","depth":3,"force":false}"#;
        assert_eq!(
            result(&form(), true, Some(answer)).unwrap(),
            json!({"action": "accept", "content": {"repo": "lattice", "branch": "dev", "depth": 3, "force": false}})
        );
        // Optional fields may be left out.
        assert_eq!(
            result(&form(), true, Some(r#"{"repo":"lattice"}"#)).unwrap()["content"],
            json!({"repo": "lattice"})
        );
    }

    #[test]
    fn a_form_answer_that_breaks_the_schema_is_refused() {
        for bad in [
            r#"{}"#,
            r#"{"repo":"x","extra":1}"#,
            r#"{"repo":"x","branch":"release"}"#,
            r#"{"repo":"x","depth":0}"#,
            r#"{"repo":"x","depth":2.5}"#,
            r#"{"repo":"x","force":"yes"}"#,
            r#"{"repo":5}"#,
            r#"not json"#,
        ] {
            assert!(result(&form(), true, Some(bad)).is_err(), "{bad}");
        }
        assert!(result(&form(), true, None).is_err());
    }

    #[test]
    fn declining_always_works_and_urls_accept_without_content() {
        for params in [form(), json!({"mode": "weird"})] {
            assert_eq!(
                result(&params, false, None).unwrap(),
                json!({"action": "decline", "content": null})
            );
        }
        assert_eq!(
            result(
                &json!({"mode": "url", "url": "https://example.com"}),
                true,
                None
            )
            .unwrap(),
            json!({"action": "accept"})
        );
        assert!(result(&json!({"mode": "weird"}), true, None).is_err());
    }
}
