import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { WorkspaceRecoveryPanel } from "./WorkspaceRecoveryPanel";

it("separates legacy history from failed sessions and never offers blind retries", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="zh-TW">
    <WorkspaceRecoveryPanel ready occupied={[]} pending={[{
      kind: "agent", groupKey: "native:codex:default:obsolete", groupLabel: "舊紀錄",
      definitionId: "codex", label: "Codex", executable: "codex", launchArguments: [],
      workingDirectory: "D:\\work", resumeSessionId: "obsolete",
    }]} onDiscardWorkspaceSession={() => {}} />
  </I18nProvider>);
  expect(html).toContain("<summary>已存專案與復原</summary>");
  expect(html).toContain("<summary>舊版匯入紀錄（1）</summary>");
  expect(html).toContain("移除捷徑不會刪除原始對話");
  expect(html).not.toContain("重試這個工作階段");
});

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
  expect(html).toContain("請先關閉這個專案的助理分頁");
  expect(html).toContain("讀取復原備份");
  expect(retry).not.toHaveBeenCalled();
});
