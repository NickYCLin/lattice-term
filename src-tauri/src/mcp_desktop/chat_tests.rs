use super::*;

fn service() -> Arc<DesktopService> {
    Arc::new(DesktopService::new(
        Arc::new(SshRegistry::new()),
        Arc::new(SftpRegistry::new()),
    ))
}
fn operation(target: &str, action: DesktopChatAction) -> DesktopOperation {
    DesktopOperation::DesktopChat {
        target_id: target.into(),
        action,
    }
}
fn events(service: &DesktopService) -> tokio::sync::mpsc::UnboundedReceiver<String> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    service.chat.set_emitter(Arc::new(move |id| {
        tx.send(id.into()).map_err(|_| ServiceError::unavailable())
    }));
    rx
}

#[tokio::test]
async fn no_threads_are_shared_without_an_explicit_window_grant() {
    let service = service();
    assert!(service.targets().is_empty());
    let nonce = service.chat.open().unwrap();
    assert!(service.targets().is_empty());
    assert!(service
        .execute("test", operation("guessed", DesktopChatAction::State {}))
        .await
        .is_err());
    let grant = service
        .share_chat(&nonce, "original", "Conversation", true, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(grant.backend, Backend::DesktopChat);
    assert!(grant.scopes.fleet_read);
    assert!(!grant.scopes.fleet_control);
    assert!(service
        .execute(
            "test",
            operation(
                &grant.id,
                DesktopChatAction::Send {
                    text: "do not send".into(),
                    request_id: "one".into()
                }
            )
        )
        .await
        .is_err());
}

#[tokio::test]
async fn control_does_not_implicitly_authorize_reading_and_wrong_backends_are_denied() {
    let service = service();
    let nonce = service.chat.open().unwrap();
    let grant = service
        .share_chat(&nonce, "original", "Conversation", false, true)
        .await
        .unwrap()
        .unwrap();
    assert!(service
        .execute(
            "test",
            operation(&grant.id, DesktopChatAction::Read { before: None })
        )
        .await
        .is_err());
    assert!(service
        .execute(
            "test",
            DesktopOperation::DesktopAgent {
                target_id: grant.id,
                action: DesktopAgentAction::State {}
            }
        )
        .await
        .is_err());
}

#[tokio::test]
async fn paged_read_is_bound_to_the_original_thread_and_claimed_only_once() {
    let service = service();
    let nonce = service.chat.open().unwrap();
    let mut rx = events(&service);
    let grant = service
        .share_chat(&nonce, "original", "Conversation", true, false)
        .await
        .unwrap()
        .unwrap();
    let worker = Arc::clone(&service);
    let task = tokio::spawn(async move {
        worker
            .execute(
                "test",
                operation(
                    &grant.id,
                    DesktopChatAction::Read {
                        before: Some("older-message".into()),
                    },
                ),
            )
            .await
    });
    let id = rx.recv().await.unwrap();
    assert!(service.chat.claim("wrong-window", &id).is_err());
    let request = service.chat.claim(&nonce, &id).unwrap();
    assert_eq!(request.thread_id, "original");
    assert!(
        matches!(request.action, DesktopChatAction::Read { before: Some(value) } if value == "older-message")
    );
    assert!(service.chat.claim(&nonce, &id).is_err());
    service
        .chat
        .reply(
            &nonce,
            &id,
            json!({"items":[{"id":"item","text":"fixture"}],"before":null}),
            None,
        )
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap()["items"][0]["text"], "fixture");
}

#[tokio::test]
async fn a_repeated_send_is_dispatched_once_and_a_changed_body_is_rejected() {
    let service = service();
    let nonce = service.chat.open().unwrap();
    let mut rx = events(&service);
    let grant = service
        .share_chat(&nonce, "original", "Conversation", true, true)
        .await
        .unwrap()
        .unwrap();
    let op = operation(
        &grant.id,
        DesktopChatAction::Send {
            text: "fixture prompt".into(),
            request_id: "same-request".into(),
        },
    );
    let worker = Arc::clone(&service);
    let first = op.clone();
    let task = tokio::spawn(async move { worker.execute("test", first).await });
    let id = rx.recv().await.unwrap();
    let request = service.chat.claim(&nonce, &id).unwrap();
    assert_eq!(request.thread_id, "original");
    assert_eq!(
        service.execute("test", op.clone()).await.unwrap()["duplicate"],
        true
    ); // still in flight
    service
        .chat
        .reply(
            &nonce,
            &id,
            json!({"threadId":"original","accepted":true}),
            None,
        )
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap()["accepted"], true);
    assert!(service.execute("test", op).await.is_ok());
    assert!(rx.try_recv().is_err());
    assert!(service
        .execute(
            "test",
            operation(
                &grant.id,
                DesktopChatAction::Send {
                    text: "different".into(),
                    request_id: "same-request".into()
                }
            )
        )
        .await
        .is_err());
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn revocation_blocks_queued_claims_and_late_reads() {
    for claimed in [false, true] {
        let service = service();
        let nonce = service.chat.open().unwrap();
        let mut rx = events(&service);
        let grant = service
            .share_chat(&nonce, "original", "Conversation", true, true)
            .await
            .unwrap()
            .unwrap();
        let worker = Arc::clone(&service);
        let target = grant.id.clone();
        let task = tokio::spawn(async move {
            worker
                .execute(
                    "test",
                    operation(&target, DesktopChatAction::Read { before: None }),
                )
                .await
        });
        let id = rx.recv().await.unwrap();
        if claimed {
            service.chat.claim(&nonce, &id).unwrap();
        }
        service.revoke(&grant.id).unwrap();
        assert!(service.chat.claim(&nonce, &id).is_err());
        assert!(service
            .chat
            .reply(&nonce, &id, json!("private fixture"), None)
            .is_err());
        assert!(task.await.unwrap().is_err());
        assert!(service.chat.state.lock().unwrap().pending.is_empty());
    }
}

#[tokio::test]
async fn reload_and_expired_heartbeats_never_restore_old_grants() {
    let service = service();
    let first = service.chat.open().unwrap();
    let old = service
        .share_chat(&first, "original", "Conversation", true, true)
        .await
        .unwrap()
        .unwrap();
    let old_identity = service.chat.identity("original");
    let second = service.chat.open().unwrap();
    let new = service
        .share_chat(&second, "original", "Conversation", true, false)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(old.id, new.id);
    assert_ne!(old_identity, service.chat.identity("original"));
    assert!(service
        .share_chat(&first, "original", "Old window", false, false)
        .await
        .is_err());
    assert!(service
        .targets()
        .iter()
        .any(|t| t.id == new.id && t.connected));
    assert!(service
        .execute("test", operation(&old.id, DesktopChatAction::State {}))
        .await
        .is_err());
    service.chat.state.lock().unwrap().lease.as_mut().unwrap().1 = Instant::now() - LEASE;
    assert!(service.chat.heartbeat(&second).is_err());
    assert!(service
        .execute("test", operation(&new.id, DesktopChatAction::State {}))
        .await
        .is_err());
}

#[tokio::test]
async fn an_expired_or_cancelled_frontend_request_cannot_be_claimed() {
    let service = service();
    let nonce = service.chat.open().unwrap();
    let mut rx = events(&service);
    let grant = service
        .share_chat(&nonce, "original", "Conversation", true, true)
        .await
        .unwrap()
        .unwrap();
    let worker = Arc::clone(&service);
    let task = tokio::spawn(async move {
        worker
            .execute(
                "test",
                operation(
                    &grant.id,
                    DesktopChatAction::Send {
                        text: "fixture".into(),
                        request_id: "cancelled".into(),
                    },
                ),
            )
            .await
    });
    let id = rx.recv().await.unwrap();
    service
        .chat
        .state
        .lock()
        .unwrap()
        .pending
        .get_mut(&id)
        .unwrap()
        .expires = Instant::now();
    assert!(service.chat.claim(&nonce, &id).is_err());
    task.abort();
    let _ = task.await;
    assert!(service.chat.state.lock().unwrap().pending.is_empty());
    assert!(service.chat.claim(&nonce, &id).is_err());
}

#[test]
fn chat_cannot_create_threads_change_models_or_approve_tools() {
    for kind in ["create", "respond", "stop", "steer", "grant"] {
        assert!(serde_json::from_value::<DesktopChatAction>(json!({"kind":kind})).is_err());
    }
    assert!(serde_json::from_value::<DesktopChatAction>(
        json!({"kind":"send","text":"hello","requestId":"one","model":"other"})
    )
    .is_err());
    for text in [" ".to_string(), "bad\0text".to_string(), "字".repeat(5500)] {
        assert!(DesktopChatAction::Send {
            text,
            request_id: "one".into()
        }
        .validate()
        .is_err());
    }
}
