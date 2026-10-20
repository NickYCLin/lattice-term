use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct DatabaseBook {
    calls: Arc<AtomicUsize>,
    pending: Option<Arc<tokio::sync::Notify>>,
}

impl ConnectionBook for DatabaseBook {
    fn profiles(&self) -> Vec<ConnectionProfile> {
        vec![]
    }
    fn database(&self, _action: crate::database::DatabaseAction) -> CredentialReadFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let pending = self.pending.clone();
        Box::pin(async move {
            if let Some(pending) = pending {
                pending.notified().await;
            }
            Ok(json!({"profiles":[]}))
        })
    }
}

fn fixture(pending: Option<Arc<tokio::sync::Notify>>) -> (Arc<DesktopService>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let service = DesktopService::new(Arc::new(SshRegistry::new()), Arc::new(SftpRegistry::new()))
        .with_connection_book(Arc::new(DatabaseBook {
            calls: calls.clone(),
            pending,
        }));
    (Arc::new(service), calls)
}

fn operation() -> DesktopOperation {
    DesktopOperation::Database {
        action: crate::database::DatabaseAction::List {},
    }
}

#[tokio::test]
async fn database_requires_the_live_connection_book_and_its_global_permission() {
    let (service, calls) = fixture(None);
    service.share_connection_book(false);
    assert_eq!(
        service
            .execute("client", operation())
            .await
            .unwrap_err()
            .code,
        "not_authorized"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    service.share_connection_book(true);
    assert_eq!(
        service.execute("client", operation()).await.unwrap(),
        json!({"profiles":[]})
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn revoked_permission_discards_an_inflight_database_result() {
    let pending = Arc::new(tokio::sync::Notify::new());
    let (service, calls) = fixture(Some(pending.clone()));
    let worker = service.clone();
    let task = tokio::spawn(async move { worker.execute("client", operation()).await });
    while calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    service.share_connection_book(false);
    pending.notify_one();
    assert_eq!(task.await.unwrap().unwrap_err().code, "not_authorized");
}

#[test]
fn new_database_operation_is_never_assumed_on_old_bridges() {
    assert_eq!(operation().kind(), "database");
    assert!(DesktopOperation::KINDS.contains(&"database"));
    assert!(!DesktopOperation::PROTOCOL_3_KINDS.contains(&"database"));
    assert_eq!(operation().target_id(), None);
}
