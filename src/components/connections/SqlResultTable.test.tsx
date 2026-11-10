import { I18nProvider } from "../../i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import { SqlResultTable } from "./SqlResultTable";
type Host = Record<string, unknown> & { childNodes?: Host[] };
type Props = { "aria-label"?: string; readOnly?: boolean; value?: string; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void };
function props(node: Host): Props[] {
  const key = Object.keys(node).find(k => k.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Props] : []), ...(node.childNodes ?? []).flatMap(props)];
}
it("filters the current preview locally and opens a selectable read-only cell", async () => {
  const container = installFakeDom(); const root = createRoot(container as unknown as Element);
  const result = { columns:["名稱","備註"], rows:[["中文資料",null],["other", ""]], truncated:false, cellCharacterLimit:512, stableOrder:false };
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><SqlResultTable result={result} /></I18nProvider>));
    await act(async () => props(container).find(p => p["aria-label"] === "篩選查詢結果")!.onChange!({target:{value:"中文"}}));
    expect(props(container).filter(p => p["aria-label"]?.includes("檢視內容"))).toHaveLength(2);
    await act(async () => props(container).find(p => p["aria-label"] === "第 1 筆，備註，檢視內容")!.onClick!());
    const preview = props(container).find(p => p["aria-label"] === "選取的儲存格內容")!;
    expect(preview.readOnly).toBe(true); expect(preview.value).toBe("NULL");
    await act(async () => props(container).find(p => p["aria-label"] === "篩選查詢結果")!.onChange!({target:{value:"missing"}}));
    expect(props(container).filter(p => p["aria-label"]?.includes("檢視內容"))).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});
