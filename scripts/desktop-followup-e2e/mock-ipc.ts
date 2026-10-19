const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrBkAAAAASUVORK5CYII=";
export async function invoke(command: string, args: Record<string, unknown> = {}) {
  if (command.startsWith("desktop_")) {
    const state = (window as typeof window & { fixtureStartup: { enabled: boolean; failure: boolean; writes: number; release?: () => void } }).fixtureStartup;
    if (command === "desktop_autostart_enabled") {
      if (state.failure) throw new Error("Synthetic unreadable setting " + "long-error-".repeat(30));
      return state.enabled;
    }
    if (command === "desktop_set_autostart") {
      state.writes++;
      await new Promise<void>(resolve => { state.release = resolve; });
      state.enabled = Boolean(args.enabled);
      return;
    }
  }
  if (command === "agent_chat_skills") return Array.from({ length: 200 }, (_, index) => ({
    name: `fixture-${index}-${"long-name-".repeat(8)}`, source: index % 2 ? "user" : "project", description: "Synthetic description ".repeat(50), kind: "skill",
  }));
  if (command === "agent_session_images_snapshot") return {
    paths: ["/synthetic/user.png"], historyAvailable: false, truncated: false,
    observed: [{ tool: "synthetic screenshot", at: "2026-01-01T00:00:00Z", localReference: false, paths: ["/synthetic/observed.png"] },
      { tool: "synthetic text-only result", at: null, localReference: false, paths: [] }],
  };
  if (command === "chat_image_preview") return args.path === "/synthetic/missing.png" ? null : png;
  throw new Error(`Unexpected synthetic IPC: ${command}`);
}
