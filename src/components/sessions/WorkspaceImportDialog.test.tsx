import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptySessionSidebarLayout } from "../../app/sessionSidebarLayout";
import { I18nProvider } from "../../i18n";
import { WorkspaceImportDialog } from "./WorkspaceImportDialog";

describe("workspace import dialog", () => {
  it("previews portable projects and disables unavailable items", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <WorkspaceImportDialog
          transfer={{
            format: "latticeterm-workspace",
            version: 1,
            exportedAt: "2026-08-28T00:00:00.000Z",
            items: [
              {
                groupKey: "group-1",
                groupLabel: "後端重構",
                definitionId: "codex",
                label: "OpenAI Codex",
                executable: "codex",
                launchArguments: [],
                workingDirectory: "D:\\project\\api",
              },
            ],
            sidebar: emptySessionSidebarLayout,
          }}
          unavailableCount={1}
          existingCount={0}
          busy={false}
          error={null}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("後端重構");
    expect(markup).toContain("D:\\project\\api");
    expect(markup).toContain("有 1 個助理在這台電腦無法使用");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>匯入 0 個工作項目<\/button>/);
  });
});
