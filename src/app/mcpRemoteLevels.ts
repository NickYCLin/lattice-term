/**
 * The two levels the MCP settings offer for a remote connection. Each level
 * becomes one or more grants, because the desktop keeps a screen and a
 * shared Fleet workspace in separate grants.
 */
export type RemoteScope = "metrics" | "list" | "exec" | "command" | "upload" | "download" | "screen" | "input" | "fleetObserve" | "fleetRead" | "fleetControl" | "fleetLaunch";
export type RemoteScopes = Record<RemoteScope, boolean>;
export type RemoteBackend = "ssh" | "sftp" | "rdp" | "vnc" | "remote";
export type RemoteLevel = "view" | "full";

export const remoteScopesOff: RemoteScopes = { metrics: false, list: false, exec: false, command: false, upload: false, download: false, screen: false, input: false, fleetObserve: false, fleetRead: false, fleetControl: false, fleetLaunch: false };

export interface LevelTarget { backend: RemoteBackend; screen?: boolean; fleet?: boolean }

export function scopesForLevel(target: LevelTarget, level: RemoteLevel): RemoteScopes[] {
  const full = level === "full";
  const screen = { ...remoteScopesOff, screen: true, input: full };
  switch (target.backend) {
    case "rdp":
    case "vnc":
      return [screen];
    case "remote":
      return [
        ...(target.screen !== false ? [screen] : []),
        ...(target.fleet ? [{ ...remoteScopesOff, fleetObserve: true, fleetRead: true, fleetControl: full, fleetLaunch: full }] : []),
      ];
    case "ssh":
      // Commands the model writes still ask the person at the desktop each time.
      return [{ ...remoteScopesOff, metrics: true, command: full }];
    case "sftp":
      return [{ ...remoteScopesOff, list: true, download: true, upload: full }];
  }
}
