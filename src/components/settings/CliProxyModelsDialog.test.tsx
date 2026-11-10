import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CliProxyModelsDialog } from "./CliProxyModelsDialog";

vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));

it("lists every model grouped by maker with a purpose tag", () => {
  const models = [
    { id: "claude-sonnet-5-5-high", ownedBy: "antigravity" },
    { id: "gemini-2.5-flash-image", ownedBy: "antigravity" },
    { id: "grok-voice-tts-1.0", ownedBy: "xai" },
    { id: "grok-4.3", ownedBy: "xai" },
    { id: "mystery-model", ownedBy: null },
  ];
  const html = renderToStaticMarkup(<I18nProvider locale="zh-TW">
    <CliProxyModelsDialog proxyName="工作代理" models={models} onClose={() => {}} />
  </I18nProvider>);
  expect(html).toContain("工作代理 的可用模型（5 個）");
  const order = ["Anthropic", "Google", "xAI", "其他"].map(label => html.indexOf(`<h3>${label} `));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  for (const model of models) expect(html).toContain(`<code>${model.id}</code>`);
  expect(html).toContain("cli-proxy-models-dialog__tag--image\">生圖");
  expect(html).toContain("cli-proxy-models-dialog__tag--audio\">語音");
  expect(html).toContain("全部 5");
  expect(html).toContain("用途依模型名稱推測");
});
