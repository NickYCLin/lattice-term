import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { WorkspaceRecoveryPanel } from "./WorkspaceRecoveryPanel";

it("keeps empty project entries visible and offers explicit retries without launching", () => {
  const retry = vi.fn();
  const html = renderToStaticMarkup(<I18nProvider locale="zh-TW">
    <WorkspaceRecoveryPanel ready localProjectDirectories={["D:\\empty", "D:\\busy"]}
      occupied={["d:/busy"]} onRemoveLocalProject={vi.fn()}
      onRetryWorkspaceSession={retry} pending={[{
        kind: "agent", groupKey: "failed", groupLabel: "待恢復", definitionId: "codex",
        label: "Codex", executable: "codex", launchArguments: [], workingDirectory: "D:\\empty",
        resumeSessionId: null,
      }]} />
  </I18nProvider>);
  expect(html).toContain("D:\\empty");
  expect(html).toContain("重試這個工作階段");
  expect(html).toContain("請先關閉這個專案的 CLI 分頁");
  expect(html).toContain("讀取復原備份");
  expect(retry).not.toHaveBeenCalled();
});
