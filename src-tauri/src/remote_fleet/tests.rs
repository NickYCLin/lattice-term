use super::*;
use crate::{
    agent::{AgentRegistry, AgentSink},
    agent_chat::AgentChatRegistry,
    agent_daemon::{
        automations::Scheduler,
        server::{DaemonSink, Logger},
        McpPlan,
    },
};
use std::time::Duration;

mod relay;

struct Daemon {
    registry: Arc<AgentRegistry>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        self.registry.stop_all();
        self.task.abort();
    }
}
fn plan(id: &str, directory: &std::path::Path) -> McpPlan {
    let marker = format!("relay-fixture-{id}");
    #[cfg(windows)]
    let (executable, arguments) = (
        std::env::var("ComSpec").unwrap(),
        vec![
            "/d".into(),
            "/q".into(),
            "/k".into(),
            format!("echo {marker}"),
        ],
    );
    #[cfg(unix)]
    let (executable, arguments) = (
        "/bin/sh".to_owned(),
        vec!["-c".into(), format!("printf '{marker}\\n'; exec cat")],
    );
    serde_json::from_value(json!({"planId":id,"label":id,"note":"","definitionId":"custom","workingDirectory":directory,"sandbox":false,"request":{"definitionId":"custom","label":id,"executable":executable,"arguments":arguments,"workingDirectory":directory,"cols":80,"rows":24}})).unwrap()
}
fn request(action: Value) -> FleetRequest {
    FleetRequest {
        version: 1,
        client: "a".repeat(64),
        action,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fleet_workspace_uses_real_daemon_ptys_and_preserves_both_permission_boundaries() {
    workspace_acceptance(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires LATTICE_FLEET_ACCEPTANCE_AGENT and LATTICE_RELAY_SMOKE_ENDPOINT"]
async fn fleet_real_agent_over_deployed_relay_with_two_ptys() {
    workspace_acceptance(true).await;
}

async fn workspace_acceptance(over_relay: bool) {
    tokio::time::timeout(Duration::from_secs(180), async {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let root = temp.path().join("approved");
        let private = temp.path().join("private");
        for path in [&data, &root, &private] {
            std::fs::create_dir(path).unwrap();
        }
        let sink = Arc::new(DaemonSink::default());
        let registry = AgentRegistry::with_local_reporter_prefixed(
            sink.clone() as Arc<dyn AgentSink>,
            crate::agent_daemon::SESSION_ID_PREFIX,
        )
        .unwrap();
        sink.plans_replace(
            true,
            vec![
                plan("one", &root),
                plan("two", &root),
                plan("private", &private),
            ],
        );
        let paths = DaemonPaths::new(&data);
        let token = crate::agent_daemon::read_or_create_token(&paths).unwrap();
        let _daemon = Daemon {
            registry: registry.clone(),
            task: tokio::spawn(crate::agent_daemon::server::serve(
                paths.clone(),
                token,
                registry.clone(),
                sink.clone(),
                Arc::new(Scheduler::open(&data)),
                Arc::new(AgentChatRegistry::new()),
                Duration::from_secs(3600),
                Arc::new(Logger::silent()),
            )),
        };
        for _ in 0..100 {
            if crate::agent_daemon::mcp::workspace_test_daemon_ready(&paths).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(crate::agent_daemon::mcp::workspace_test_daemon_ready(&paths).await);
        let grant = HostGrant {
            directory: root.to_string_lossy().into_owned(),
            read: true,
            control: true,
            launch: true,
        };
        let access = Access::new(paths.clone(), &grant).unwrap();
        let access = relay::TestAccess::new(access, over_relay, temp.path()).await;
        let metadata = Access::new(
            paths.clone(),
            &HostGrant {
                read: false,
                control: false,
                launch: false,
                ..grant.clone()
            },
        )
        .unwrap();
        let plans = metadata
            .perform(request(json!({"kind":"listPlans"})))
            .await
            .unwrap();
        assert_eq!(plans["plans"].as_array().unwrap().len(), 2);
        assert_eq!(plans["enabled"], false);
        assert!(!plans.to_string().contains("private"));
        let launch = |id: &str| {
            request(json!({"kind":"launch","planId":id,"requestId":format!("launch-{id}")}))
        };
        assert!(metadata.perform(launch("one")).await.is_err());
        assert!(access.perform(launch("private")).await.is_err());
        let (one, two) = tokio::join!(access.perform(launch("one")), access.perform(launch("two")));
        let one = one.unwrap()["session"]["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let two = two.unwrap()["session"]["sessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(one, two);
        assert_eq!(
            access.perform(launch("one")).await.unwrap()["session"]["sessionId"],
            one
        );
        assert_eq!(registry.list().len(), 2);
        access.reconnect().await;
        let read = |id: &str| {
            request(json!({"kind":"readOutput","sessionId":id,"cursor":0,"maxBytes":4096}))
        };
        assert!(metadata.perform(read(&one)).await.is_err());
        assert!(access.perform(read(&one)).await.is_ok());
        if over_relay {
            let mut output_seen = false;
            for _ in 0..50 {
                let value = access.perform(read(&one)).await.unwrap();
                if value.to_string().contains("relay-fixture-one") {
                    assert!(!value.to_string().contains("relay-fixture-two"));
                    output_seen = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(output_seen, "real PTY output must cross the Relay");
            assert!(access
                .perform(read(&two))
                .await
                .unwrap()
                .to_string()
                .contains("relay-fixture-two"));
            assert!(access
                .perform(request(
                    json!({"kind":"readOutput","sessionId":one,"cursor":0,"maxBytes":1048576})
                ))
                .await
                .is_err());
            println!("RELAY_FLEET_REAL_PTYS=2; OUTPUT=verified; RECONNECT=verified");
        }
        sink.set_shared_output(&two, true, Some(false));
        assert!(access.perform(read(&two)).await.is_err());
        assert!(access
            .perform(request(
                json!({"kind":"readOutput","sessionId":one,"directory":private})
            ))
            .await
            .is_err());
        assert!(access
            .perform(request(json!({"kind":"exec","command":"anything"})))
            .await
            .is_err());
        access.revoke();
        assert!(access.perform(read(&one)).await.is_err());
        assert!(access.perform(launch("two")).await.is_err());
        assert_eq!(registry.list().len(), 2);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn fleet_rejects_missing_daemon_relative_roots_and_revoked_grants() {
    let temp = tempfile::tempdir().unwrap();
    let paths = DaemonPaths::new(&temp.path().join("data"));
    let mut grant = HostGrant {
        directory: "relative".into(),
        read: false,
        control: false,
        launch: false,
    };
    assert!(Access::new(paths.clone(), &grant).is_err());
    grant.directory = temp.path().to_string_lossy().into_owned();
    let access = Access::new(paths, &grant).unwrap();
    assert!(access
        .perform(request(json!({"kind":"listSessions"})))
        .await
        .is_err());
    access.revoke();
    assert!(access
        .perform(request(json!({"kind":"listSessions"})))
        .await
        .is_err());
}
