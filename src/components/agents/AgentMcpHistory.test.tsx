import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentMcpHistory as History } from "../../app/useAgentDaemon";
import { I18nProvider } from "../../i18n";
import { AgentMcpHistory } from "./AgentMcpHistory";

const render = (history: History | null, locale: "zh-TW" | "en" = "zh-TW") =>
  renderToStaticMarkup(
    <I18nProvider locale={locale}><AgentMcpHistory history={history} /></I18nProvider>,
  );

describe("MCP operation history", () => {
  it("distinguishes unavailable history from a verified empty history", () => {
    expect(render(null)).toContain("目前無法取得紀錄");
    expect(render(null)).not.toContain("沒有可顯示的 MCP 操作紀錄");
    const empty = render({ entries: [], limit: 256, discarded: 0 });
    expect(empty).toContain("沒有可顯示的 MCP 操作紀錄");
    expect(empty).not.toContain("目前無法取得紀錄");
  });

  it.each(["zh-TW", "en"] as const)("renders bounded, escaped metadata in %s", (locale) => {
    const history: History = {
      limit: 256, discarded: 10,
      entries: (["accepted", "replayed", "failed", "unknown"] as const).map((outcome, id) => ({
        id, at: 1_700_000_000_000, client: "<script>alert(1)</script>",
        action: "stop", outcome, sessionId: id ? "agent-bg-session-test" : null,
      })),
    };
    const markup = render(history, locale);
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("agent-bg-session-test");
    expect(markup).toContain("256");
    expect(markup).toContain("10");
    expect(markup).toContain("<time dateTime=");
    expect(markup).not.toContain("agents.mcp.");
    expect(markup).toContain(locale === "zh-TW" ? "目前只保留在記憶體" : "In memory only");
  });

  it("distinguishes persisted, pending and unsafe storage even with no entries", () => {
    const base: History = { entries: [], limit: 256, discarded: 0 };
    expect(render({ ...base, persistence: "ready" })).toContain("重啟後可還原");
    expect(render({ ...base, persistence: "pending" })).toContain("尚未寫入的紀錄可能遺失");
    const unsafe = render({ ...base, persistence: "unavailable", persistenceReason: "externalChange" });
    expect(unsafe).toContain("不會自動清空既有紀錄");
    expect(unsafe).toContain("紀錄檔已被其他程式修改");
    expect(unsafe).not.toContain("重啟後可還原");
  });
});
