//! Bounded progress and history from the existing write ledger.
//! No commands, paths or output are included in the history listing.

use super::*;

impl DesktopService {
    pub(super) fn list_operations(
        &self,
        client: &str,
        target_id: &str,
    ) -> Result<Value, ServiceError> {
        let state = self.state.lock().map_err(|_| ServiceError::failed())?;
        let mut entries: Vec<_> = state
            .operations
            .values()
            .filter(|entry| {
                entry.client == client
                    && entry.target_id == target_id
                    && entry
                        .finished_at
                        .is_none_or(|time| time.elapsed() < OPERATION_RETENTION)
            })
            .collect();
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.started_at));
        let operations: Vec<_> = entries
            .into_iter()
            .map(|entry| {
                let (status, code) = match &entry.result {
                    None => ("running", None),
                    Some(Ok(value)) => (value["state"].as_str().unwrap_or("completed"), None),
                    Some(Err(error)) => ("failed", Some(error.code.as_str())),
                };
                json!({
                    "operationId": entry.id, "requestId": entry.request_id,
                    "kind": entry.kind, "state": status, "code": code,
                    "completed": entry.result.is_some(), "elapsedMs": elapsed_ms(entry),
                    "phase": phase(&state, entry),
                })
            })
            .collect();
        Ok(json!({
            "operations": operations,
            "retentionMs": OPERATION_RETENTION.as_millis() as u64,
            "maxRetainedOperations": MAX_OPERATIONS,
            "historySurvivesRestart": false,
        }))
    }
}

fn elapsed_ms(entry: &OperationRecord) -> u64 {
    entry
        .finished_at
        .unwrap_or_else(Instant::now)
        .saturating_duration_since(entry.started_at)
        .as_millis() as u64
}

pub(super) fn phase(state: &State, entry: &OperationRecord) -> &'static str {
    if entry.result.is_some() {
        "finished"
    } else if state.approvals.contains_key(&entry.id) {
        "awaitingApproval"
    } else if *entry.cancel.borrow() {
        "cancelling"
    } else {
        "executing"
    }
}

pub(super) fn with_tracking(
    entry: &OperationRecord,
    mut value: Value,
) -> Result<Value, ServiceError> {
    if let Some(object) = value.as_object_mut() {
        object
            .entry("operationId")
            .or_insert_with(|| json!(entry.id));
        object.insert("completed".into(), json!(entry.result.is_some()));
        object.insert("elapsedMs".into(), json!(elapsed_ms(entry)));
        object.insert("duplicate".into(), json!(true));
    }
    Ok(value)
}

impl OperationLease {
    pub(super) fn publish_progress(&self, value: Value) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(entry) = state.operations.get_mut(&self.id) {
                if entry.result.is_none() {
                    entry.progress = Some(value);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserve(
        service: &DesktopService,
        client: &str,
        target: &str,
        request: &str,
    ) -> OperationLease {
        let operation = DesktopOperation::ExecCommand {
            target_id: target.into(),
            command: "private command".into(),
            request_id: request.into(),
        };
        match service
            .reserve(client, request, target, &operation)
            .unwrap()
        {
            Reservation::New(lease) => lease,
            _ => panic!("expected new operation"),
        }
    }

    #[test]
    fn history_is_client_and_target_scoped_and_omits_contents() {
        let service = super::super::tests::service();
        let mut first = reserve(&service, "alice", "one", "first");
        first.publish_progress(json!({"state":"running", "stdout":"private output"}));
        let _other_client = reserve(&service, "bob", "one", "second");
        let _other_target = reserve(&service, "alice", "two", "third");
        let list = service.list_operations("alice", "one").unwrap();
        assert_eq!(list["operations"].as_array().unwrap().len(), 1);
        assert_eq!(list["operations"][0]["requestId"], "first");
        assert_eq!(list["operations"][0]["completed"], false);
        assert!(!list.to_string().contains("private"));
        assert_eq!(
            service.operation_status("alice", "one", &first.id).unwrap()["stdout"],
            "private output"
        );
        assert!(service.operation_status("bob", "one", &first.id).is_err());
        first.finish(Ok(json!({"state":"exited","exitStatus":7,"stdout":"done"})));
        first.publish_progress(json!({"state":"running","stdout":"stale"}));
        let status = service.operation_status("alice", "one", &first.id).unwrap();
        assert_eq!(status["completed"], true);
        assert_eq!(status["stdout"], "done");
        assert_eq!(status["exitStatus"], 7);
        let list = service.list_operations("alice", "one").unwrap();
        assert_eq!(list["operations"][0]["state"], "exited");
    }

    #[test]
    fn history_expires_completed_entries_but_keeps_running_work_and_failure_codes() {
        let service = super::super::tests::service();
        let mut expired = reserve(&service, "alice", "one", "expired");
        let mut failed = reserve(&service, "alice", "one", "failed");
        let _running = reserve(&service, "alice", "one", "running");
        expired.finish(Ok(json!({"state":"exited"})));
        failed.finish(Err(ServiceError::new("unknown_outcome", "private details")));
        service
            .state
            .lock()
            .unwrap()
            .operations
            .get_mut(&expired.id)
            .unwrap()
            .finished_at = Some(Instant::now() - OPERATION_RETENTION - Duration::from_secs(1));
        let list = service.list_operations("alice", "one").unwrap();
        let entries = list["operations"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["requestId"], "running");
        assert_eq!(entries[1]["code"], "unknown_outcome");
        assert_eq!(entries[1]["completed"], true);
        assert!(!list.to_string().contains("private"));
        assert!(service
            .operation_status("alice", "one", &expired.id)
            .is_err());
    }
}
