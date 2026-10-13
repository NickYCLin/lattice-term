import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { useSshSessions } from "./useSshSessions";
import { useSftpSessions } from "./useSftpSessions";
import { useRdpSessions } from "./useRdpSessions";
import { useVncSessions } from "./useVncSessions";
import { useRemoteSessions } from "./useRemoteSessions";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
}));

const summary = {
  sessionId: "fixture-session", profileId: "fixture", host: "example.test", port: 22,
  username: "fixture", agentName: "fixture", width: 0, height: 0, frame: null,
  interactive: false, viaRelay: false, viewOnly: true, fileTransfer: false,
  fileRootLabel: "", terminal: false,
};

beforeEach(() => {
  invoke.mockImplementation(async (command: string) => command.endsWith("_sessions") ? [summary] : []);
});
afterEach(() => { vi.resetAllMocks(); listeners.clear(); });

for (const [kind, useSessions] of [
  ["ssh", useSshSessions], ["sftp", useSftpSessions], ["rdp", useRdpSessions],
  ["vnc", useVncSessions], ["remote", useRemoteSessions],
] as const) {
  it(`${kind} retains a live session when disconnect fails and allows retry`, async () => {
    const root = createRoot(installFakeDom() as unknown as Element);
    let api!: { sessions: Array<{ sessionId: string }>; disconnect: (id: string) => Promise<void> };
    function Probe() { api = useSessions(); return null; }
    try {
      await act(async () => root.render(<Probe />));
      expect(api.sessions).toHaveLength(1);
      invoke.mockImplementation(async (command: string) => {
        if (command === `${kind}_disconnect`) throw new Error("fixture IPC unavailable");
        return [];
      });
      await act(async () => { await expect(api.disconnect(summary.sessionId)).rejects.toThrow("fixture IPC unavailable"); });
      expect(api.sessions.map(session => session.sessionId)).toEqual([summary.sessionId]);
      invoke.mockResolvedValue(undefined);
      await act(async () => api.disconnect(summary.sessionId));
      expect(api.sessions).toEqual([]);
    } finally { await act(async () => root.unmount()); }
  });
}
