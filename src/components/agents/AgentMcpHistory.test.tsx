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
    expect(render(null)).not.toContain("還沒有 MCP 寫入請求");
    const empty = render({ entries: [], limit: 256, discarded: 0 });
    expect(empty).toContain("還沒有 MCP 寫入請求");
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
    expect(markup).toContain(locale === "zh-TW" ? "背景服務結束就清除" : "clears when the service ends");
  });
});
