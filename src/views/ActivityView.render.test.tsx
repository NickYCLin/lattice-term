/**
 * Static render of the activity page with nothing recorded yet: both the
 * agent and the audit sections say so instead of showing empty tables.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityApi } from "../app/useAgentActivity";
import type { Workspace } from "../app/useWorkspace";
import { I18nProvider } from "../i18n";
import { ActivityView } from "./ActivityView";

describe("ActivityView", () => {
  it.each([false, true])("shows only supported activity when mobile=%s", (mobile) => {
    const workspace = { activity: [], clearActivity: vi.fn() } as unknown as Workspace;
    const agentActivity: AgentActivityApi = {
      items: [],
      unreadCount: 0,
      markGroupRead: vi.fn(),
      markAllRead: vi.fn(),
      clear: vi.fn(),
    };
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <ActivityView
          mobile={mobile}
          workspace={workspace}
          agentActivity={agentActivity}
          onOpenAgentActivity={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(markup).toContain("還沒有任何紀錄");
    expect(markup).not.toContain("<table");
    if (mobile) expect(markup).not.toContain("CLI 工作活動");
    else expect(markup).toContain("CLI 工作活動");
  });
});
