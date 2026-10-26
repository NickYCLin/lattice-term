import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { ProjectLaunchSettings } from "./ProjectLaunchSettings";

describe("project launch authorization settings", () => {
  it("defaults to disabled and explains full permission and sharing risks", () => {
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><ProjectLaunchSettings disabled={false} save={async (p) => p} reportError={() => {}} /></I18nProvider>);
    expect(markup).toContain("預設全權限");
    expect(markup).toContain("不限制 CLI 存取其他檔案");
    expect(markup).toContain("所有已授權");
    expect(markup).not.toContain('checked=""');
    expect(markup).not.toContain("立即關閉專案啟動");
  });
  it("shows persisted roots, inherited permissions and an immediate revocation action", () => {
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><ProjectLaunchSettings disabled={false} policy={{enabled:true, roots:["/projects/approved"], fullPermissions:false}} save={async (p) => p} reportError={() => {}} /></I18nProvider>);
    expect(markup).toContain("/projects/approved");
    expect(markup).toContain('value="saved" selected=""');
    expect(markup).toContain('checked=""');
    expect(markup).toContain("立即關閉專案啟動");
  });
});
