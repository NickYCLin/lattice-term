//! Native progress and usage reports; values are never inferred from a model name.
use super::{str_field, truncate, ChatEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub text: String,
    pub status: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub objective: String,
    pub status: String,
    pub tokens_used: u64,
    pub token_budget: Option<u64>,
    pub time_used_seconds: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub key: String,
    pub label: String,
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<i64>,
}

pub(crate) fn plan_steps(value: &Value, claude: bool) -> Option<Vec<PlanStep>> {
    let entries = value.as_array()?;
    if entries.len() > 64 {
        return None;
    }
    entries
        .iter()
        .map(|entry| {
            let text = str_field(entry, if claude { "content" } else { "step" })?;
            let status = match str_field(entry, "status")? {
                "pending" => "pending",
                "inProgress" | "in_progress" => "inProgress",
                "completed" => "completed",
                _ => return None,
            };
            Some(PlanStep {
                text: truncate(text, 1024),
                status: status.into(),
            })
        })
        .collect()
}

pub(super) fn codex_notification(method: &str, params: &Value) -> Vec<ChatEvent> {
    let mut events = Vec::new();
    match method {
        "item/commandExecution/outputDelta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta"
        | "item/plan/delta" => {
            if let (Some(id), Some(delta)) =
                (str_field(params, "itemId"), str_field(params, "delta"))
            {
                if method == "item/commandExecution/outputDelta" {
                    events.push(ChatEvent::ToolOutputDelta {
                        item_id: id.into(),
                        delta: truncate(delta, 65536),
                    });
                } else if method == "item/plan/delta" {
                    events.push(ChatEvent::TextDelta {
                        item_id: id.into(),
                        delta: truncate(delta, 65536),
                    });
                } else {
                    events.push(ChatEvent::ReasoningDelta {
                        item_id: id.into(),
                        delta: truncate(delta, 65536),
                        part: params
                            .get(if method.ends_with("summaryTextDelta") {
                                "summaryIndex"
                            } else {
                                "contentIndex"
                            })
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        summary: method.ends_with("summaryTextDelta"),
                    });
                }
            }
        }
        "turn/plan/updated" => {
            if let Some(steps) = plan_steps(&params["plan"], false) {
                events.push(ChatEvent::PlanUpdated {
                    steps,
                    explanation: str_field(params, "explanation").map(|s| truncate(s, 4096)),
                });
            }
        }
        "thread/goal/updated" => {
            let goal = &params["goal"];
            if let (Some(objective), Some(status), Some(tokens_used), Some(time_used_seconds)) = (
                str_field(goal, "objective"),
                str_field(goal, "status"),
                goal["tokensUsed"].as_u64(),
                goal["timeUsedSeconds"].as_u64(),
            ) {
                if matches!(
                    status,
                    "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"
                ) {
                    events.push(ChatEvent::GoalUpdated {
                        goal: Some(GoalState {
                            objective: truncate(objective, 4096),
                            status: status.into(),
                            tokens_used,
                            token_budget: goal["tokenBudget"].as_u64(),
                            time_used_seconds,
                        }),
                    });
                }
            }
        }
        "thread/goal/cleared" => events.push(ChatEvent::GoalUpdated { goal: None }),
        "thread/tokenUsage/updated" => {
            let usage = &params["tokenUsage"];
            let last = &usage["last"];
            let tokens = last["totalTokens"].as_u64().or_else(|| {
                Some(
                    last["inputTokens"]
                        .as_u64()?
                        .saturating_add(last["outputTokens"].as_u64()?),
                )
            });
            if let Some(tokens_used) = tokens {
                events.push(ChatEvent::ContextUsage {
                    tokens_used,
                    context_window: usage["modelContextWindow"]
                        .as_u64()
                        .filter(|value| *value > 0),
                });
            }
        }
        "account/rateLimits/updated" => {
            let snapshot = &params["rateLimits"];
            let id = str_field(snapshot, "limitId").unwrap_or("codex");
            let label = str_field(snapshot, "limitName").unwrap_or("Codex");
            let windows = ["primary", "secondary"]
                .into_iter()
                .filter_map(|bucket| {
                    let window = &snapshot[bucket];
                    let used_percent = window["usedPercent"].as_f64()?;
                    if !used_percent.is_finite() || !(0.0..=10000.0).contains(&used_percent) {
                        return None;
                    }
                    Some(RateLimitWindow {
                        key: format!("{}:{bucket}", truncate(id, 128)),
                        label: truncate(label, 128),
                        used_percent,
                        window_minutes: window["windowDurationMins"].as_u64(),
                        resets_at: window["resetsAt"].as_i64().filter(|value| *value >= 0),
                    })
                })
                .collect::<Vec<_>>();
            if !windows.is_empty() {
                events.push(ChatEvent::RateLimits { windows });
            }
        }
        "thread/compacted" => events.push(ChatEvent::ContextCompacted),
        _ => {}
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn keeps_usage_distinct_from_lifetime_totals_and_reports_only_available_limits() {
        let events = codex_notification(
            "thread/tokenUsage/updated",
            &json!({"tokenUsage":{"last":{"totalTokens":120},"total":{"totalTokens":9999},"modelContextWindow":200000}}),
        );
        assert_eq!(
            events,
            [ChatEvent::ContextUsage {
                tokens_used: 120,
                context_window: Some(200000)
            }]
        );
        assert!(codex_notification("thread/tokenUsage/updated", &json!({})).is_empty());
        let events = codex_notification(
            "account/rateLimits/updated",
            &json!({"rateLimits":{"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1800000000}}}),
        );
        let ChatEvent::RateLimits { windows } = &events[0] else {
            panic!()
        };
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 25.0);
    }
    #[test]
    fn normalizes_codex_plans_and_claude_todos_without_guessing_completion() {
        assert_eq!(
            plan_steps(&json!([{"step":"test","status":"inProgress"}]), false).unwrap()[0].status,
            "inProgress"
        );
        assert_eq!(
            plan_steps(&json!([{"content":"test","status":"in_progress"}]), true).unwrap()[0]
                .status,
            "inProgress"
        );
        assert!(plan_steps(&json!([{"step":"test","status":"other"}]), false).is_none());
        let events = codex_notification(
            "thread/goal/updated",
            &json!({"goal":{"objective":"finish","status":"active","tokensUsed":10,"tokenBudget":100,"timeUsedSeconds":2}}),
        );
        assert!(
            matches!(&events[0], ChatEvent::GoalUpdated { goal:Some(goal) } if goal.tokens_used==10 && goal.status=="active")
        );
    }
    #[test]
    fn forwards_command_and_reasoning_deltas_with_separate_parts() {
        assert!(
            matches!(&codex_notification("item/commandExecution/outputDelta",&json!({"itemId":"c","delta":"one\n"}))[0], ChatEvent::ToolOutputDelta {delta,..} if delta=="one\n")
        );
        assert!(matches!(
            &codex_notification(
                "item/reasoning/summaryTextDelta",
                &json!({"itemId":"r","delta":"part","summaryIndex":2})
            )[0],
            ChatEvent::ReasoningDelta {
                part: 2,
                summary: true,
                ..
            }
        ));
    }
}
