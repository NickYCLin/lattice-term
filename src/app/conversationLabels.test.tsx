import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../i18n";
import { ConversationMetadata } from "../components/chat/ConversationPresentation";
import { conversationLabels } from "./conversationLabels";
import { chatWorkspaceProjection } from "./chatWorkspaceNodes";
import { fakeDefinition, fakeSession } from "./testFixtures/agentApis";
import { cliProxyLaunchArguments } from "./cliProxyApi";

it("never guesses an upstream from endpoint branding, tool branding or a model name", () => {
  for (const endpoint of ["Herdr", "CLIProxyAPI", "OpenAI 自訂連線"]) {
    expect(conversationLabels({ definitionId: "codex", directApi: true, endpoint, model: "gpt-synthetic" }).provider).toBeNull();
  }
  expect(conversationLabels({ definitionId: "codex", provider: "openai" }).provider).toBe("OpenAI");
  expect(conversationLabels({ definitionId: "codex", provider: "custom-adapter" }).provider).toBeNull();
  expect(conversationLabels({ definitionId: "codex", provider: "openai", endpoint: "Custom endpoint" }).provider).toBeNull();
  expect(conversationLabels({ definitionId: "codex", provider: "openai", directApi: true }).provider).toBeNull();
});

it("separates CLI, API, model, project, account and custom endpoint without changing names", () => {
  const endpoint = "使用者自訂端點".repeat(9);
  const labels = conversationLabels({ definitionId: "codex", directApi: true, endpoint, model: "synthetic-model", account: "測試帳號", workingDirectory: "C:\\Work\\daily-log-helper" });
  expect(labels).toEqual({ provider: null, source: "Codex API", model: "synthetic-model", endpoint, account: "測試帳號", project: "daily-log-helper" });
  const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><ConversationMetadata labels={labels} /></I18nProvider>);
  for (const text of ["Codex API", "模型: synthetic-model", `連線: ${endpoint}`, "帳號: 測試帳號", "專案: daily-log-helper"]) expect(markup).toContain(text);
  expect(conversationLabels({ definitionId: "codex" }).source).toBe("Codex CLI");
});

it("shows a model fallback rather than mistaking a project or endpoint for a model", () => {
  const labels = conversationLabels({ definitionId: "codex", model: "  ", workingDirectory: "/work/project" });
  const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><ConversationMetadata labels={labels} /></I18nProvider>);
  expect(markup).toContain("模型: 未知");
  expect(labels).toMatchObject({ model: null, endpoint: null, account: null, project: "project" });
  expect(conversationLabels({ definitionId: "custom-cli" }).source).toBe("custom-cli");
  expect(conversationLabels({ definitionId: "claude" }).source).toBe("Claude Code");
});

it("keeps native/live node identity and user labels stable when presenting an API-backed CLI", () => {
  const session = fakeSession({ label: "我的自訂名稱", launchArguments: cliProxyLaunchArguments("https://fixture.invalid", "endpoint"), model: null });
  const old = chatWorkspaceProjection([session], [fakeDefinition()], "一般對話");
  const current = chatWorkspaceProjection([session], [fakeDefinition()], "一般對話", [{ id: "endpoint", label: "我的端點", baseUrl: "https://fixture.invalid" }]);
  expect(current.nodes).toEqual(old.nodes);
  expect([...current.sessions.values()][0]).toMatchObject({ label: [...old.sessions.values()][0].label,
    metadata: { source: "Codex CLI", endpoint: "我的端點", model: null } });
  expect([...old.sessions.values()][0].metadata?.endpoint).toBe("CLIProxyAPI");
  expect(session.label).toBe("我的自訂名稱");
});
