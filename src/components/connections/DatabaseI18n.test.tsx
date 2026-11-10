import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { loadCatalogue } from "../../i18n/catalog";
import type { DatabaseProfile } from "../../domain/database";
import { DatabaseConnectionCard } from "./DatabaseConnectionCard";
import { DatabaseDock } from "./DatabaseDock";
import { DatabaseManager } from "./DatabaseManager";
import { SqlResultTable } from "./SqlResultTable";
import { SqlWorkbench } from "./SqlWorkbench";

vi.mock("../../app/useRuntimeSummary", () => ({ useRuntimeSummary: () => ({ host: "tauri", summary: { platform: "windows" } }) }));

const profile: DatabaseProfile = {
  id: "fixture", hostKey: "local", name: "Fixture", engine: "postgres",
  hostname: "db.invalid", port: 5432, username: "reader", database: "sample",
  sqlitePath: "", allowMcpRead: false,
};

describe.each([
  { locale: "en" as const, workspace: "Database workspace", open: "Open SQL", filter: "Filter query results", name: "Connection name" },
  { locale: "zh-CN" as const, workspace: "数据库工作区", open: "打开 SQL", filter: "筛选查询结果", name: "连接名称" },
  { locale: "de" as const, workspace: "Database workspace", open: "Open SQL", filter: "Filter query results", name: "Connection name" },
])("database UI in $locale", ({ locale, workspace, open, filter, name }) => {
  it("localizes setup, cards, workbench, dock and parameterized result labels", async () => {
    await loadCatalogue(locale);
    const html = renderToStaticMarkup(<I18nProvider locale={locale}>
      <DatabaseManager profiles={[]} onClose={() => {}} />
      <DatabaseConnectionCard profile={profile} remoteName="Fixture remote" onOpen={() => {}} onEdit={() => {}} />
      <DatabaseDock profiles={[]} open={false} visible onClose={() => {}} />
      <SqlWorkbench profileId={profile.id} />
      <SqlResultTable result={{ columns: ["value"], rows: [["sample"]], truncated: false, cellCharacterLimit: 512, stableOrder: false }} />
    </I18nProvider>);
    for (const text of [workspace, open, filter, name]) expect(html).toContain(text);
    for (const text of ["資料庫工作區", "篩選查詢結果", "與對話、工作階段並排查詢", "允許 MCP 修改 SQL 草稿"]) expect(html).not.toContain(text);
    expect(html).not.toMatch(/\{(?:count|limit|row|column|name|permission|visible|total|columns)\}/);
    expect(html).toContain(locale === "zh-CN" ? "第 1 条，value，查看内容" : "Row 1, value, view contents");
  });
});
