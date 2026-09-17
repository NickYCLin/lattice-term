import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  emptySessionSidebarLayout,
  reconcileSessionSidebarLayout,
} from "../../app/sessionSidebarLayout";
import { I18nProvider } from "../../i18n";
import { SessionProjectSidebar } from "./SessionProjectSidebar";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session project sidebar", () => {
  it("renders every CLI member as an independent project child", () => {
    vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
    const projectNodeId = "project:local:latticeterm";
    const sessionNodeId = "session:agent:codex";
    const claudeNodeId = "session:agent:claude";
    const secondCodexNodeId = "session:agent:codex-default";
    const layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      { id: projectNodeId, defaultParentId: null },
      { id: sessionNodeId, defaultParentId: projectNodeId },
      { id: claudeNodeId, defaultParentId: projectNodeId },
      { id: secondCodexNodeId, defaultParentId: projectNodeId },
    ]);

    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <SessionProjectSidebar
          projects={[
            {
              nodeId: projectNodeId,
              projectId: "local:latticeterm",
              label: "LatticeTerm",
              workingDirectory: "/workspace/LatticeTerm",
              sessions: [
                {
                  nodeId: sessionNodeId,
                  sessionId: "agent-codex",
                  label: "Codex",
                  detail: "gpt-5.6-sol",
                  kind: "agent",
                  status: "working",
                },
                {
                  nodeId: claudeNodeId,
                  sessionId: "agent-claude",
                  label: "Claude Code",
                  detail: "CLI 預設模型",
                  kind: "agent",
                  status: "idle",
                },
                {
                  nodeId: secondCodexNodeId,
                  sessionId: "agent-codex-default",
                  label: "OpenAI Codex",
                  detail: "CLI 預設模型",
                  kind: "agent",
                  status: "idle",
                },
              ],
            },
          ]}
          layout={layout}
          activeSessionId="agent-claude"
          choosingProject={false}
          chooseError={false}
          installedAgents={[]}
          mobileOpen
          onMobileClose={vi.fn()}
          onChooseProject={vi.fn()}
          onBrowseHistory={vi.fn()}
          onLaunchProject={vi.fn()}
          onSelect={vi.fn()}
          onRemove={vi.fn()}
          onQuickLaunch={vi.fn()}
          onExportWorkspace={vi.fn()}
          onImportWorkspace={vi.fn()}
          onClearWorkspace={vi.fn()}
          onCreateFolder={vi.fn()}
          onRenameFolder={vi.fn()}
          onDeleteFolder={vi.fn()}
          onToggleFolder={vi.fn()}
          onRevealNode={vi.fn()}
          onMove={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("LatticeTerm");
    expect(markup).toContain("外部對話");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("OpenAI Codex");
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup.match(/CLI 預設模型/g)).toHaveLength(2);
    expect(markup).toContain('class="session-tree__project is-active"');
    expect(markup).toContain('data-folder-state="open"');
    expect(markup).toContain("session-tree__branch-toggle");
    expect(markup).not.toContain("session-tree__project is-active status-working");
    expect(markup.match(/session-tree__status status-working/g)).toHaveLength(1);
    expect(markup).toContain('class="session-tree__session is-active status-idle"');
    expect(markup).toContain('aria-label="工作階段狀態說明"');
    expect(markup).toContain('aria-controls="session-project-status-guide"');
    expect(markup).not.toContain('status-working"><span aria-hidden="true"></span>執行中');
    expect(markup).toContain("移除「Codex」工作階段");
    expect(markup).toContain('placeholder="搜尋專案或工作階段"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('role="list" aria-label="專案與工作階段"');
    expect(markup.match(/role="listitem"/g)).toHaveLength(4);
    expect(markup).not.toContain('role="tree"');
    expect(markup).not.toContain('role="treeitem"');
    expect(markup).toContain('id="session-project-sidebar"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('tabindex="-1"');
  });

  it("keeps an empty saved project visible and offers to reopen a CLI", () => {
    vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
    const projectNodeId = "project:local:latticeterm";
    const layout = reconcileSessionSidebarLayout(emptySessionSidebarLayout, [
      { id: projectNodeId, defaultParentId: null },
    ]);

    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <SessionProjectSidebar
          projects={[
            {
              nodeId: projectNodeId,
              projectId: "local:latticeterm",
              label: "LatticeTerm",
              workingDirectory: "D:\\project\\LatticeTerm",
              sessions: [],
            },
          ]}
          layout={layout}
          activeSessionId={null}
          choosingProject={false}
          chooseError={false}
          installedAgents={[]}
          mobileOpen={false}
          onMobileClose={vi.fn()}
          onChooseProject={vi.fn()}
          onLaunchProject={vi.fn()}
          onSelect={vi.fn()}
          onRemove={vi.fn()}
          onQuickLaunch={vi.fn()}
          onExportWorkspace={vi.fn()}
          onImportWorkspace={vi.fn()}
          onClearWorkspace={vi.fn()}
          onCreateFolder={vi.fn()}
          onRenameFolder={vi.fn()}
          onDeleteFolder={vi.fn()}
          onToggleFolder={vi.fn()}
          onRevealNode={vi.fn()}
          onMove={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("LatticeTerm");
    expect(markup).toContain('aria-label="在這個專案新增工作階段"');
  });
});
