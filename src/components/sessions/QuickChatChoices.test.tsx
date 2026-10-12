import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { accountModelLaunchSettings, accountModelOptions, accountModelTargets, type AccountModelSelection } from "../../app/accountModels";
import { fakeDefinition } from "../../app/testFixtures/agentApis";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import { I18nProvider } from "../../i18n";
import { QuickChatChoices } from "./QuickChatChoices";

vi.mock("../icons", () => ({ AgentIcon: () => null }));

const definition = fakeDefinition({ account: { state: "signedOut", label: null, method: null } });
const proxies = [
  { id: "default", label: "工作代理", baseUrl: "http://localhost:8317" },
  { id: "backup", label: "備援代理", baseUrl: "https://proxy.example" },
];
const options = accountModelOptions(accountModelTargets([definition], [], {}, "預設帳號"), {},
  { defaultModel: "預設模型", loading: "讀取中", signedOut: "尚未登入" }, undefined, proxies);

describe("quick chat sources", () => {
  it.each([false, true])("lists configured proxies and installed CLIs in menu mode %s", menu => {
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <QuickChatChoices installedAgents={[definition]} modelOptions={options} menu={menu}
        onLaunch={vi.fn()} onLaunchProxy={vi.fn()} />
    </I18nProvider>);
    expect(markup).toContain("CLIProxyAPI · 工作代理");
    expect(markup).toContain("CLIProxyAPI · 備援代理");
    expect(markup).toContain(definition.label);
    expect(markup.match(/<button /g)).toHaveLength(3);
    expect(markup.match(/role="menuitem"/g) ?? []).toHaveLength(menu ? 3 : 0);
  });

  it("does not offer removed, disabled or isolated-account proxy sources", () => {
    const proxy = options.find(option => option.provider)!;
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <QuickChatChoices installedAgents={[definition]} onLaunch={vi.fn()} onLaunchProxy={vi.fn()}
        modelOptions={[...options.filter(option => !option.provider),
          { ...proxy, disabled: true }, { ...proxy, accountProfileId: "team", label: "團隊代理" }]} />
    </I18nProvider>);
    expect(markup).not.toContain("CLIProxyAPI");
    expect(markup).toContain(definition.label);
  });

  it("keeps each clicked proxy identity and waits for an explicit model selection", async () => {
    const container = installFakeDom();
    const root = createRoot(container as unknown as Element);
    const onLaunch = vi.fn();
    const onLaunchProxy = vi.fn();
    try {
      await act(async () => root.render(<I18nProvider locale="zh-TW">
        <QuickChatChoices installedAgents={[definition]} modelOptions={options} menu
          onLaunch={onLaunch} onLaunchProxy={onLaunchProxy} />
      </I18nProvider>));
      const nodes = container.childNodes as Record<string, unknown>[];
      const callbacks = nodes.map(node => {
        const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
        return node[key] as { onClick: () => void };
      });
      await act(async () => callbacks[1].onClick());
      const selection = onLaunchProxy.mock.calls[0][0] as AccountModelSelection;
      expect(selection).toEqual({ definitionId: "codex", accountProfileId: null, provider: "cliproxyapi",
        proxyId: "backup", model: "" });
      expect(onLaunch).not.toHaveBeenCalled();
      expect(() => accountModelLaunchSettings(selection, [], proxies)).toThrow("invalid-proxy-model");
      const settings = accountModelLaunchSettings({ ...selection, model: "gpt-5.6" }, [], proxies);
      expect(settings.arguments.join(" ")).toContain("https://proxy.example");
      expect(() => accountModelLaunchSettings({ ...selection, model: "gpt-5.6" }, [], proxies.slice(0, 1)))
        .toThrow("missing-proxy");
      await act(async () => callbacks[2].onClick());
      expect(onLaunch).toHaveBeenCalledWith(definition);
      expect(onLaunchProxy).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
