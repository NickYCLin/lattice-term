//! Read only progress actually present in this exact native transcript.
use super::*;
use crate::agent_chat::{GoalState, PlanStep, RateLimitWindow};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProgress {
    pub context_usage: Option<ContextUsage>,
    pub rate_limits: Vec<RateLimitWindow>,
    pub plan: Vec<PlanStep>,
    pub goal: Option<GoalState>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    tokens_used: u64,
    context_window: Option<u64>,
}

pub(super) fn read(path: &Path, kind: TranscriptKind) -> SessionProgress {
    let mut progress = SessionProgress::default();
    let mut pending: HashMap<String, Vec<PlanStep>> = HashMap::new();
    let _ = visit_transcript_rows(path, |row| {
        let mut masked = row.clone();
        redact::value(&mut masked);
        let row = &masked;
        let payload = &row["payload"];
        if kind == TranscriptKind::Codex
            && row["type"] == "event_msg"
            && payload["type"] == "token_count"
        {
            let info = &payload["info"];
            let last = &info["last_token_usage"];
            if let Some(tokens_used) = last["total_tokens"].as_u64() {
                progress.context_usage = Some(ContextUsage {
                    tokens_used,
                    context_window: info["model_context_window"]
                        .as_u64()
                        .filter(|value| *value > 0),
                });
            }
            for bucket in ["primary", "secondary"] {
                let window = &payload["rate_limits"][bucket];
                if let Some(percent) = window["used_percent"]
                    .as_f64()
                    .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
                {
                    let next = RateLimitWindow {
                        key: format!("codex:{bucket}"),
                        label: "Codex".into(),
                        used_percent: percent,
                        window_minutes: window["window_minutes"].as_u64(),
                        resets_at: window["resets_at"].as_i64().filter(|value| *value >= 0),
                    };
                    progress.rate_limits.retain(|window| window.key != next.key);
                    progress.rate_limits.push(next);
                }
            }
        }
        if kind == TranscriptKind::Claude && row["type"] == "assistant" {
            let usage = &row["message"]["usage"];
            if let Some(input) = usage["input_tokens"].as_u64() {
                progress.context_usage = Some(ContextUsage {
                    tokens_used: input
                        .saturating_add(usage["cache_read_input_tokens"].as_u64().unwrap_or(0))
                        .saturating_add(usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)),
                    context_window: None,
                });
            }
        }
        if kind == TranscriptKind::Codex
            && payload["type"] == "function_call"
            && payload["name"] == "update_plan"
        {
            if let (Some(id), Some(raw)) =
                (payload["call_id"].as_str(), payload["arguments"].as_str())
            {
                if let Ok(args) = serde_json::from_str::<Value>(raw) {
                    if let Some(plan) =
                        crate::agent_chat::runtime_events::plan_steps(&args["plan"], false)
                    {
                        if pending.len() < 64 {
                            pending.insert(id.into(), plan);
                        }
                    }
                }
            }
        }
        if kind == TranscriptKind::Codex && payload["type"] == "function_call_output" {
            if let Some(plan) = payload["call_id"]
                .as_str()
                .and_then(|id| pending.remove(id))
            {
                if payload["output"]
                    .as_str()
                    .is_some_and(|text| text.trim() == "Plan updated")
                {
                    progress.plan = plan;
                }
            }
        }
        if kind == TranscriptKind::Claude {
            if let Some(blocks) = row["message"]["content"].as_array() {
                for block in blocks {
                    if block["type"] == "tool_use" && block["name"] == "TodoWrite" {
                        if let (Some(id), Some(plan)) = (
                            block["id"].as_str(),
                            crate::agent_chat::runtime_events::plan_steps(
                                &block["input"]["todos"],
                                true,
                            ),
                        ) {
                            if pending.len() < 64 {
                                pending.insert(id.into(), plan);
                            }
                        }
                    }
                    if block["type"] == "tool_result" {
                        if let Some(plan) = block["tool_use_id"]
                            .as_str()
                            .and_then(|id| pending.remove(id))
                        {
                            if block["is_error"] != true {
                                progress.plan = plan;
                            }
                        }
                    }
                }
            }
        }
    });
    progress
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(rows: &[Value], kind: TranscriptKind) -> SessionProgress {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic.jsonl");
        fs::write(
            &path,
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        read(&path, kind)
    }
    #[test]
    fn context_uses_last_turn_not_cumulative_tokens_and_keeps_actual_limit_windows() {
        let result = fixture(
            &[
                json!({"type":"event_msg","payload":{"type":"token_count","info":{
            "total_token_usage":{"total_tokens":999999},"last_token_usage":{"total_tokens":1200},"model_context_window":64000},
            "rate_limits":{"primary":{"used_percent":25.5,"window_minutes":300,"resets_at":1790000000},"secondary":{"used_percent":101}}}}),
            ],
            TranscriptKind::Codex,
        );
        let usage = result.context_usage.unwrap();
        assert_eq!(usage.tokens_used, 1200);
        assert_eq!(usage.context_window, Some(64000));
        assert_eq!(result.rate_limits.len(), 1);
        assert_eq!(result.rate_limits[0].used_percent, 25.5);
    }
    #[test]
    fn proposed_or_failed_plans_are_not_reported_as_applied() {
        let call = |id: &str| json!({"type":"response_item","payload":{"type":"function_call","name":"update_plan","call_id":id,"arguments":json!({"plan":[{"step":"實作","status":"in_progress"}]}).to_string()}});
        let result = |id: &str, text: &str| json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":text}});
        assert!(fixture(&[call("pending")], TranscriptKind::Codex)
            .plan
            .is_empty());
        assert!(fixture(
            &[
                call("failed"),
                result("failed", "error"),
                result("unknown", "Plan updated")
            ],
            TranscriptKind::Codex
        )
        .plan
        .is_empty());
        let progress = fixture(
            &[call("valid"), result("valid", "Plan updated")],
            TranscriptKind::Codex,
        );
        assert_eq!(progress.plan.len(), 1);
        assert_eq!(progress.plan[0].status, "inProgress");
    }
    #[test]
    fn claude_counts_input_caches_and_requires_successful_todo_receipt() {
        let call = json!({"type":"assistant","uuid":"assistant-1","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":200,"cache_creation_input_tokens":50},"content":[{"type":"tool_use","id":"todo-1","name":"TodoWrite","input":{"todos":[{"content":"檢查","status":"completed"}]}}]}});
        let result = |error| json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"todo-1","is_error":error,"content":"saved"}]}});
        let failed = fixture(&[call.clone(), result(true)], TranscriptKind::Claude);
        assert!(failed.plan.is_empty());
        assert_eq!(failed.context_usage.unwrap().tokens_used, 350);
        let saved = fixture(&[call, result(false)], TranscriptKind::Claude);
        assert_eq!(saved.plan[0].status, "completed");
        assert!(saved.context_usage.unwrap().context_window.is_none());
    }
    #[test]
    fn compaction_receipts_require_new_complete_native_records() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history.jsonl");
        fs::write(&path, "").unwrap();
        assert!(super::super::compaction_receipt(&path).unwrap().is_none());
        fs::write(&path, format!("{}\n", json!({"type":"event_msg","payload":{"type":"agent_message","message":"Context compacted"}}))).unwrap();
        assert!(super::super::compaction_receipt(&path).unwrap().is_none());
        let first = json!({"timestamp":"2026-11-16T01:00:00Z","type":"compacted","payload":{"message":"","replacement_history":[]}});
        fs::write(&path, format!("{first}\n")).unwrap();
        let baseline = super::super::compaction_receipt(&path).unwrap().unwrap();
        fs::write(
            &path,
            format!("{first}\n{{\"type\":\"compacted\",\"payload\":"),
        )
        .unwrap();
        assert_eq!(
            super::super::compaction_receipt(&path).unwrap().as_deref(),
            Some(baseline.as_str())
        );
        let second = json!({"timestamp":"2026-11-16T01:01:00Z","type":"compacted","payload":{"message":"","replacement_history":[]}});
        fs::write(&path, format!("{first}\n{second}\n")).unwrap();
        assert_ne!(
            super::super::compaction_receipt(&path).unwrap().as_deref(),
            Some(baseline.as_str())
        );
    }

    #[test]
    fn transcript_exposes_tools_and_only_public_reasoning_summaries() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history.jsonl");
        fs::write(&path, format!("{}\n", json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"public summary"}],"encrypted_content":"hidden encrypted bytes"}}))).unwrap();
        let snapshot =
            super::super::read_conversation_snapshot_with_tools(&path, TranscriptKind::Codex, true)
                .unwrap();
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].text, "public summary");
        assert_eq!(
            snapshot.messages[0].tool.as_ref().unwrap().kind,
            "reasoning"
        );
        fs::write(&path, format!("{}\n{}\n", json!({"type":"assistant","uuid":"assistant-1","message":{"content":[{"type":"thinking","thinking":"visible thinking"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"path":"/synthetic"}},{"type":"text","text":"answer"}]}}), json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":[{"type":"text","text":"result"}]}]}}))).unwrap();
        let snapshot = super::super::read_conversation_snapshot_with_tools(
            &path,
            TranscriptKind::Claude,
            true,
        )
        .unwrap();
        assert_eq!(snapshot.messages.len(), 4);
        assert_eq!(
            snapshot.messages[1].tool.as_ref().unwrap().call_id,
            "tool-1"
        );
        assert_eq!(snapshot.messages[2].text, "result");
        assert_eq!(snapshot.messages[3].text, "answer");
    }
}
