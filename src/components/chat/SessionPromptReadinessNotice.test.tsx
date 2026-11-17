import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { SessionPromptReadinessNotice } from "./SessionPromptReadinessNotice";

function render(readiness: Parameters<typeof SessionPromptReadinessNotice>[0]["readiness"]) {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <SessionPromptReadinessNotice readiness={readiness} onReconcile={() => {}} />
    </I18nProvider>,
  );
}

it("explains stuck MCP blockers in Traditional Chinese and offers reconcile", () => {
  const html = render({
    ready: false,
    blockers: ["integration_not_reported", "terminal_turn_unconfirmed"],
    basis: "unconfirmed",
    unconfirmedMs: 45_000,
  });
  expect(html).toContain("就緒狀態已卡住 45 秒，MCP 目前無法送訊息。");
  expect(html).toContain("助理尚未正式回報回合結束。");
  expect(html).toContain("終端回合尚未確認結束。");
  expect(html).toContain("重新對帳");
  expect(html).not.toContain("integration_not_reported");
});

it("hides the notice once readiness is restored", () => {
  const html = render({ ready: true, blockers: [], basis: "completed_native_turn", unconfirmedMs: null });
  expect(html).toBe("");
});
