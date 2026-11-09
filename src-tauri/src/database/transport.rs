use super::{DatabaseProfile, DatabaseRegistry, DatabaseRoute};
use crate::storage::Storage;
use std::sync::Arc;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub(super) struct ConnectionRoute {
    pub profile: DatabaseProfile,
    worker: Option<JoinHandle<()>>,
    ssh: Option<(Arc<crate::tunnel::TunnelRegistry>, String)>,
}
impl Drop for ConnectionRoute {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
        if let Some((registry, id)) = self.ssh.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    if registry.stop(&id).await.is_ok() {
                        registry.forget_database_tunnel(&id);
                    }
                });
            }
        }
    }
}

impl DatabaseRegistry {
    pub(super) async fn connection_route(
        &self,
        profile: &DatabaseProfile,
    ) -> Result<ConnectionRoute, String> {
        let mut result = ConnectionRoute {
            profile: profile.clone(),
            worker: None,
            ssh: None,
        };
        let Some(route) = &profile.route else {
            return Ok(result);
        };
        let app = self.app.as_ref().ok_or("此環境未提供資料庫遠端通道。")?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "無法建立本機資料庫通道。")?;
        let port = listener
            .local_addr()
            .map_err(|_| "無法取得資料庫通道連接埠。")?
            .port();
        match route {
            DatabaseRoute::Ssh { profile_id } => {
                let mut nonce = [0u8; 16];
                getrandom::fill(&mut nonce).map_err(|_| "無法建立資料庫通道識別碼。")?;
                let id = format!(
                    "database-{}",
                    nonce
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                );
                let request = crate::tunnel::StartTunnelRequest {
                    tunnel_id: id.clone(),
                    tunnel_type: crate::tunnel::TunnelType::Local,
                    profile_id: profile_id.clone(),
                    local_host: "127.0.0.1".into(),
                    local_port: port,
                    remote_host: profile.hostname.clone(),
                    remote_port: profile.port,
                    ssh_hostname: String::new(),
                    ssh_port: 0,
                    ssh_username: String::new(),
                };
                let registry = app
                    .state::<Arc<crate::tunnel::TunnelRegistry>>()
                    .inner()
                    .clone();
                result.ssh = Some((registry, id));
                crate::tunnel_start_internal(
                    request,
                    app.state(),
                    app.state(),
                    app.state(),
                    Some(listener),
                )
                .await?;
            }
            DatabaseRoute::Remote { profile_id } => {
                let gateway = {
                    let storage = app.state::<crate::AppStorage>();
                    let storage = storage.lock().map_err(|_| "無法讀取 Remote 連線設定。")?;
                    storage
                        .get_profile(profile_id)
                        .map_err(|_| "無法讀取 Remote 連線設定。")?
                        .filter(|gateway| gateway.protocol == crate::domain::Protocol::Lattice)
                        .ok_or("指定的 Lattice Remote 連線已移除或類型不符。")?
                };
                let registry = app.state::<Arc<crate::remote::RemoteRegistry>>();
                let connector = registry.database_connector(&gateway)?;
                let host = profile.hostname.clone();
                let remote_port = profile.port;
                result.worker = Some(tokio::spawn(async move {
                    let mut connections = tokio::task::JoinSet::new();
                    loop {
                        tokio::select! {
                            accepted = listener.accept() => {
                                let Ok((mut local, _)) = accepted else { break; };
                                if connections.len() >= lattice_remote::tcp_protocol::MAX_STREAMS { continue; }
                                let connector = connector.clone();
                                let host = host.clone();
                                connections.spawn(async move {
                                    if let Ok(mut remote) = connector.connect(host, remote_port).await {
                                        let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                                    }
                                });
                            }
                            _ = connections.join_next(), if !connections.is_empty() => {}
                        }
                    }
                }));
            }
        }
        result.profile.hostname = "127.0.0.1".into();
        result.profile.port = port;
        Ok(result)
    }
}
