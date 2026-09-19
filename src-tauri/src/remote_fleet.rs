//! One explicitly selected host workspace, reached over the encrypted Remote request lane.
//! Raw terminal/chat grants never authorize this adapter. Daemon MCP grants still apply.
use crate::{
    agent_daemon::{mcp::McpServer, DaemonPaths},
    mcp_desktop::{FleetAction, Scopes},
};
use lattice_remote::fleet_protocol::FleetRequest;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::watch;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostGrant {
    pub directory: String,
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub control: bool,
    #[serde(default)]
    pub launch: bool,
}
pub struct Access {
    root: PathBuf,
    directory: String,
    paths: DaemonPaths,
    scopes: Scopes,
    revoked: watch::Sender<bool>,
}
impl Access {
    pub fn new(paths: DaemonPaths, grant: &HostGrant) -> Result<Arc<Self>, String> {
        // Left blank, the workspace is the user's home folder: every project
        // under it, but still a named folder and never the filesystem root.
        let home;
        let directory = if grant.directory.trim().is_empty() {
            home = dirs::home_dir()
                .ok_or("Cannot find the home folder; enter a workspace directory.")?
                .to_string_lossy()
                .into_owned();
            &home
        } else {
            &grant.directory
        };
        #[cfg(windows)]
        if !crate::mcp_desktop::valid_windows_workspace_path(directory) {
            return Err("Choose a local workspace directory.".into());
        }
        let path = std::path::Path::new(directory);
        if directory.len() > 4096 || directory.chars().any(char::is_control) || !path.is_absolute()
        {
            return Err("Choose an absolute workspace directory.".into());
        }
        let root = path
            .canonicalize()
            .map_err(|_| "The workspace directory is unavailable.")?;
        if !root.is_dir() || root.parent().is_none() {
            return Err("Choose a project directory, not a filesystem root.".into());
        }
        let directory = root.to_string_lossy().into_owned();
        #[cfg(windows)]
        let directory = directory
            .strip_prefix(r"\\?\")
            .unwrap_or(&directory)
            .to_owned();
        #[cfg(windows)]
        if !crate::mcp_desktop::valid_windows_workspace_path(&directory) {
            return Err("The resolved workspace must be a local project directory.".into());
        }
        Ok(Arc::new(Self {
            root,
            directory,
            paths,
            scopes: Scopes {
                fleet_observe: true,
                fleet_read: grant.read,
                fleet_control: grant.control,
                fleet_launch: grant.launch,
                ..Default::default()
            },
            revoked: watch::channel(false).0,
        }))
    }
    /// The folder actually shared, after a blank entry became the home folder.
    pub fn directory(&self) -> &str {
        &self.directory
    }
    pub fn revoke(&self) {
        self.revoked.send_replace(true);
    }
    fn check(&self) -> Result<(), String> {
        if *self.revoked.borrow() || self.root.canonicalize().ok().as_ref() != Some(&self.root) {
            return Err("Fleet sharing was revoked or its workspace changed.".into());
        }
        Ok(())
    }
    pub async fn perform(&self, request: FleetRequest) -> Result<Value, String> {
        self.check()?;
        if !request.valid() {
            return Err("Invalid Fleet request.".into());
        }
        let action: FleetAction =
            serde_json::from_value(request.action).map_err(|_| "Unsupported Fleet operation.")?;
        action.validate().map_err(|_| "Invalid Fleet operation.")?;
        if !self.scopes.allows(action.scope()) {
            return Err("The host did not grant this Fleet capability.".into());
        }
        let mut revoked = self.revoked.subscribe();
        let work = async {
            self.check()?;
            let server = McpServer::workspace(self.paths.clone(), self.directory.clone());
            server.handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":format!("relay-fleet-{}", request.client),"version":"1"}}})).await;
            let (tool, arguments) = action.tool();
            let capabilities = server.handle(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_capabilities","arguments":{}}})).await.ok_or("The workspace is unavailable.")?;
            let capabilities = &capabilities["result"]["structuredContent"];
            if capabilities["workspaceScope"] != true
                || capabilities["workspaceScoped"] != true
                || capabilities["daemonRunning"] != true
            {
                return Err(
                    "Start an updated background service and grant MCP access on the host.".into(),
                );
            }
            let reply = server.handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":arguments}})).await.ok_or("Fleet did not acknowledge the operation.")?;
            self.check()?;
            let mut result = reply
                .get("result")
                .cloned()
                .ok_or("Invalid Fleet response.")?;
            if result["isError"] == true {
                // Do not release daemon diagnostic paths or account material.
                return Err(
                    "The workspace refused the operation. Check its MCP grants and session state."
                        .into(),
                );
            }
            let value = result
                .get_mut("structuredContent")
                .ok_or("Invalid Fleet response.")?;
            crate::mcp_desktop::intersect_fleet_scopes(value, &self.scopes);
            if serde_json::to_vec(value)
                .map_err(|_| "Invalid Fleet response.")?
                .len()
                > 56 * 1024
            {
                return Err(
                    "Fleet response exceeds the snapshot limit. Request a smaller page.".into(),
                );
            }
            Ok(value.clone())
        };
        tokio::select! {
            biased;
            _ = revoked.changed() => Err("Fleet sharing was revoked.".into()),
            result = tokio::time::timeout(std::time::Duration::from_secs(7), work) => result.map_err(|_| "Unknown Fleet outcome. Inspect the session before retrying.".to_owned())?,
        }
    }
}

#[cfg(test)]
mod tests;
