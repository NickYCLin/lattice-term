//! Real SSH channels, remote MCP stdio framing, daemon socket and multiple PTYs.
//! The SSH exec peer starts the actual in-process adapter instead of a shell.
use super::*;
use crate::agent::{AgentRegistry, AgentSink};
use crate::agent_chat::AgentChatRegistry;
use crate::agent_daemon::{
    automations::Scheduler,
    server::{DaemonSink, Logger},
    DaemonPaths, McpPlan,
};
use std::path::Path;

struct Daemon {
    paths: DaemonPaths,
    registry: Arc<AgentRegistry>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        self.registry.stop_all();
        self.task.abort();
        self.paths.remove_socket_hint();
        let _ = std::fs::remove_file(&self.paths.socket);
    }
}
fn plan(id: &str, directory: &Path, live: bool) -> McpPlan {
    if live {
        let executable =
            std::env::var("LATTICETERM_FLEET_TEST_CODEX").expect("explicit test Codex executable");
        return serde_json::from_value(json!({"planId":id,"label":id,"note":"","definitionId":"codex","workingDirectory":directory,"sandbox":false,
            "request":{"definitionId":"codex","label":id,"executable":executable,"arguments":["--sandbox","read-only","--ask-for-approval","never","--no-alt-screen","-c","web_search=\"disabled\"","-c","allow_login_shell=false","-c","mcp_servers.node_repl={enabled=false,command=\"latticeterm-live-acceptance-disabled\"}","-c",format!("projects={{{}={{trust_level=\"trusted\"}}}}",serde_json::to_string(directory).unwrap()),"Do not use tools, read files, change files, or start background work. Reply with just READY."],"workingDirectory":directory,"cols":180,"rows":40}})).unwrap();
    }
    serde_json::from_value(json!({"planId":id,"label":id,"note":"","definitionId":"custom","workingDirectory":directory,"sandbox":false,
        "request":{"definitionId":"custom","label":id,"executable":"/bin/sh","arguments":["-c",format!("printf '{id} output\\n'; exec cat")],"workingDirectory":directory,"cols":80,"rows":24}})).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ssh_fleet_multiplexes_real_ptys_with_scopes_and_revocation() {
    bounded(exercise(false)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Requires explicit local Codex executable, login and compiled MCP binary; uses model service"]
async fn ssh_fleet_two_live_codex_ptys_without_a_desktop_renderer() {
    assert!(std::env::var_os("LATTICETERM_FLEET_TEST_BINARY").is_some());
    tokio::time::timeout(Duration::from_secs(240), exercise(true))
        .await
        .unwrap();
}

async fn exercise(live: bool) {
    let temp = tempfile::tempdir().unwrap();
    let data = Arc::new(temp.path().join("data"));
    let root = Arc::new(temp.path().join("approved"));
    let private = temp.path().join("private");
    for directory in [&*data, &*root, &private] {
        std::fs::create_dir(directory).unwrap();
    }
    let sink = Arc::new(DaemonSink::default());
    let registry = if live {
        AgentRegistry::with_test_reporter_executable(
            Arc::clone(&sink) as Arc<dyn AgentSink>,
            std::env::var_os("LATTICETERM_FLEET_TEST_BINARY")
                .unwrap()
                .into(),
            crate::agent_daemon::SESSION_ID_PREFIX,
        )
    } else {
        AgentRegistry::with_local_reporter_prefixed(
            Arc::clone(&sink) as Arc<dyn AgentSink>,
            crate::agent_daemon::SESSION_ID_PREFIX,
        )
    }
    .unwrap();
    sink.plans_replace(
        true,
        vec![
            plan("first", &root, live),
            plan("second", &root, live),
            plan("private", &private, live),
        ],
    );
    let paths = DaemonPaths::new(&data);
    let token = crate::agent_daemon::read_or_create_token(&paths).unwrap();
    let daemon = Daemon {
        paths: paths.clone(),
        registry: Arc::clone(&registry),
        task: tokio::spawn(crate::agent_daemon::server::serve(
            paths.clone(),
            token,
            Arc::clone(&registry),
            Arc::clone(&sink),
            Arc::new(Scheduler::open(&data)),
            Arc::new(AgentChatRegistry::new()),
            Duration::from_secs(3600),
            Arc::new(Logger::silent()),
        )),
    };
    for _ in 0..100 {
        if paths.socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(paths.socket.exists());
    let peer = Peer::start_with_sftp(SftpMode::Fleet {
        data: Arc::clone(&data),
        directory: Arc::clone(&root),
    })
    .await;
    let ssh = Arc::new(SshRegistry::new());
    let terminal = Arc::new(Sink::default());
    let ConnectOutcome::Connected { session_id } = crate::ssh::connect(
        terminal.clone(),
        Arc::clone(&ssh),
        Some(peer.known.clone()),
        peer.request(),
    )
    .await
    else {
        panic!("trusted test transport failed");
    };
    let service = Arc::new(DesktopService::new(
        Arc::clone(&ssh),
        Arc::new(SftpRegistry::new()),
    ));
    let request = |scopes| GrantRequest {
        session_id: session_id.clone(),
        backend: Backend::Ssh,
        label: "approved workspace".into(),
        scopes,
        exec_plans: vec![],
        roots: vec![],
        fleet: Some(FleetWorkspace {
            executable: "/test/lattice-term".into(),
            data_directory: data.to_string_lossy().into_owned(),
            directory: root.to_string_lossy().into_owned(),
        }),
    };
    let metadata = service
        .grant(request(Scopes {
            fleet_observe: true,
            ..Default::default()
        }))
        .await
        .unwrap();
    let grant = service
        .grant(request(Scopes {
            fleet_observe: true,
            fleet_read: true,
            fleet_control: true,
            fleet_launch: true,
            ..Default::default()
        }))
        .await
        .unwrap();
    let call = |target: String, action| {
        let service = Arc::clone(&service);
        async move {
            service
                .execute(
                    "fleet-client",
                    DesktopOperation::Fleet {
                        target_id: target,
                        action,
                    },
                )
                .await
        }
    };
    let plans = call(grant.id.clone(), FleetAction::ListPlans {})
        .await
        .unwrap();
    assert_eq!(plans["result"]["plans"].as_array().unwrap().len(), 2);
    assert!(!plans.to_string().contains("private"));
    let action = |id: &str| FleetAction::Launch {
        plan_id: id.into(),
        request_id: format!("launch-{id}"),
    };
    assert_eq!(
        call(metadata.id.clone(), action("first"))
            .await
            .unwrap_err()
            .code,
        "not_authorized"
    );
    assert_eq!(
        call(grant.id.clone(), action("private"))
            .await
            .unwrap_err()
            .code,
        "not_authorized"
    );
    let (first, second) = tokio::join!(
        call(grant.id.clone(), action("first")),
        call(grant.id.clone(), action("second"))
    );
    let first = first.unwrap();
    let second = second.unwrap();
    let first_id = first["result"]["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let second_id = second["result"]["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(first_id, second_id);
    assert_eq!(
        call(grant.id.clone(), action("first")).await.unwrap()["duplicate"],
        true
    );
    let sessions = call(grant.id.clone(), FleetAction::ListSessions {})
        .await
        .unwrap();
    assert_eq!(sessions["result"]["sessions"].as_array().unwrap().len(), 2);
    let read = |id: String| FleetAction::ReadOutput {
        session_id: id,
        cursor: 0,
        max_bytes: 4096,
    };
    assert_eq!(
        call(metadata.id.clone(), read(first_id.clone()))
            .await
            .unwrap_err()
            .code,
        "not_authorized"
    );
    if live {
        for (id, expected) in [(&first_id, "24682"), (&second_id, "27160")] {
            loop {
                let state = call(
                    grant.id.clone(),
                    FleetAction::WaitState {
                        session_id: id.clone(),
                        timeout_ms: 1000,
                    },
                )
                .await
                .unwrap();
                let state = &state["result"]["session"];
                if state["stateSource"] == "integration"
                    && matches!(state["state"].as_str(), Some("idle" | "done"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            let before = call(grant.id.clone(), read(id.clone())).await.unwrap();
            let cursor = before["result"]["nextCursor"].as_u64().unwrap();
            let operand = if id == &first_id { 12341 } else { 13580 };
            call(grant.id.clone(), FleetAction::Send { session_id:id.clone(), text:format!("Do not use tools or read or modify files. Calculate {operand} times two mentally. Reply with only the result."), mode:"now".into(), request_id:format!("prompt-{operand}") }).await.unwrap();
            loop {
                let result = call(
                    grant.id.clone(),
                    FleetAction::ReadOutput {
                        session_id: id.clone(),
                        cursor,
                        max_bytes: 32768,
                    },
                )
                .await
                .unwrap();
                let state = call(
                    grant.id.clone(),
                    FleetAction::WaitState {
                        session_id: id.clone(),
                        timeout_ms: 1000,
                    },
                )
                .await
                .unwrap();
                let state = &state["result"]["session"];
                if result["result"]["text"]
                    .as_str()
                    .unwrap()
                    .contains(expected)
                    && state["stateSource"] == "integration"
                    && matches!(state["state"].as_str(), Some("idle" | "done"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    let output = call(grant.id.clone(), read(first_id.clone()))
        .await
        .unwrap();
    if !live {
        assert!(output["result"]["text"]
            .as_str()
            .unwrap()
            .contains("first output"));
        assert!(!output["result"]["text"]
            .as_str()
            .unwrap()
            .contains("second output"));
    }
    sink.set_shared_output(&second_id, true, Some(false));
    assert_eq!(
        call(grant.id.clone(), read(second_id.clone()))
            .await
            .unwrap_err()
            .code,
        "not_authorized"
    );
    let cancel = FleetAction::Cancel {
        session_id: first_id.clone(),
        scope: "session".into(),
        request_id: "stop-first".into(),
    };
    assert_eq!(
        call(grant.id.clone(), cancel.clone()).await.unwrap()["result"]["ended"],
        true
    );
    assert_eq!(
        call(grant.id.clone(), cancel).await.unwrap()["duplicate"],
        true
    );
    assert!(registry.session_summary(&second_id).is_some());
    service.revoke(&grant.id).unwrap();
    assert_eq!(
        call(grant.id.clone(), FleetAction::ListSessions {})
            .await
            .unwrap_err()
            .code,
        "not_authorized"
    );
    assert!(registry.session_summary(&second_id).is_some());
    assert!(ssh.session_handle(&session_id).is_some());
    // All Agent traffic used dedicated exec channels; the original PTY
    // received no commands or remote MCP JSON.
    assert!(terminal.0.lock().unwrap().is_empty());
    assert_eq!(peer.authentications.load(Ordering::Relaxed), 1);
    assert!(peer.execs.load(Ordering::Relaxed) >= 8);
    drop(daemon);
}
