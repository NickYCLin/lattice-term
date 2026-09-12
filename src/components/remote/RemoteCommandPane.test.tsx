import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import type { RemoteSessionSummary } from "../../app/useRemoteSessions";
import { RemoteCommandPane } from "./RemoteCommandPane";
const mock = vi.hoisted(() => ({ state: "running", stdout: "<script>unsafe()</script>中文" }));
vi.mock("../../app/useRemoteCommand", () => ({
  commandActive: (view: { state: string }) => view.state === "running",
  useRemoteCommand: () => ({ ready: true, problem: null, start: vi.fn(), cancel: vi.fn(), view: { id: 1, state: mock.state, command: "echo example", directory: "C:\\test", stdout: mock.stdout, stderr: "stderr marker", exitCode: mock.state === "running" ? null : 7, detail: "" } }),
}));
function render(flags: number, hidden = false) {
  return renderToStaticMarkup(<I18nProvider locale="zh-TW"><RemoteCommandPane session={{ sessionId: "test", commandShells: flags } as RemoteSessionSummary} hidden={hidden} /></I18nProvider>);
}
describe("remote command panel", () => {
  it("shows only granted shells and renders output as text", () => {
    mock.state = "running";
    const markup = render(2);
    expect(markup).toContain('value="powerShell"');
    expect(markup).not.toContain('value="cmd"');
    expect(markup).toContain("&lt;script&gt;unsafe()&lt;/script&gt;中文");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("停止");
    expect(markup).toContain("stderr marker");
  });
  it("retains the result when hidden and shows a nonzero exit status", () => {
    mock.state = "exited";
    const markup = render(3, true);
    expect(markup).toContain('hidden=""');
    expect(markup).toContain("結束代碼: 7");
    expect(markup).toContain('value="cmd"');
    expect(markup).not.toContain(">停止</button>");
  });
});
