import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Callout, EmptyState } from "./Callout";
import { DesktopDescription, MobilePresentationProvider } from "./MobilePresentation";
import { ConfirmDialog } from "../overlays/ConfirmDialog";

it.each(["ios", "android", "linux"])("omits only opted-in explanations on %s and preserves actionable/status content", platform => {
  const markup = renderToStaticMarkup(<MobilePresentationProvider platform={platform}>
    <DesktopDescription><Callout tone="security" title="純說明標題">純說明正文</Callout></DesktopDescription>
    <EmptyState icon={null} title="空狀態標題" description="空狀態說明" footnote="空狀態註腳" actions={<button>新增</button>} />
    <Callout tone="warn" title="離線狀態">中繼離線</Callout>
    <Callout tone="danger" title="驗證失敗">欄位錯誤</Callout>
    <Callout tone="security" title="已儲存"><button>使用</button><button>刪除</button></Callout>
    <ConfirmDialog title="刪除確認" body="刪除後無法復原" confirmLabel="確認刪除" cancelLabel="取消" onConfirm={vi.fn()} onCancel={vi.fn()} />
    <label>欄位標籤（選填）<input placeholder="保留 placeholder" /></label>
  </MobilePresentationProvider>);
  for (const text of ["純說明標題", "純說明正文", "空狀態說明", "空狀態註腳"]) expect(markup.includes(text)).toBe(platform === "linux");
  for (const text of ["空狀態標題", "新增", "中繼離線", "欄位錯誤", "已儲存", "使用", "刪除", "刪除後無法復原", "確認刪除", "取消", "欄位標籤（選填）", "保留 placeholder"]) expect(markup).toContain(text);
});

it("honours app--mobile presentation independently of the native platform", () => {
  const markup = renderToStaticMarkup(<MobilePresentationProvider mobile><DesktopDescription>手機不應渲染</DesktopDescription><button>保留操作</button></MobilePresentationProvider>);
  expect(markup).not.toContain("手機不應渲染"); expect(markup).toContain("保留操作");
});
