/** The operations a remote connection can offer an external AI tool. */
export type RemoteScope = "metrics" | "list" | "exec" | "command" | "upload" | "download" | "screen" | "input" | "fleetObserve" | "fleetRead" | "fleetControl" | "fleetLaunch";
export type RemoteScopes = Record<RemoteScope, boolean>;
export type RemoteBackend = "ssh" | "sftp" | "rdp" | "vnc" | "remote";

/** Every scope, all off: the shape a target's scope set is read against. */
export const remoteScopesOff: RemoteScopes = { metrics: false, list: false, exec: false, command: false, upload: false, download: false, screen: false, input: false, fleetObserve: false, fleetRead: false, fleetControl: false, fleetLaunch: false };
