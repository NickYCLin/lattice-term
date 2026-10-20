import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import type { ChatDefinitionId, ChatModelList } from "../../app/agentChat";
import {
  ModelField,
  decodeModelSelection,
  encodeModelSelection,
} from "./ModelField";

const models: Record<ChatDefinitionId, ChatModelList> = {
  claude: {
    state: "ready",
    models: [
      { value: "", label: "Default", description: null, isDefault: true },
      { value: "sonnet", label: "Sonnet", description: null, isDefault: false },
    ],
  },
  codex: {
    state: "ready",
    models: [
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol", description: null, isDefault: true },
    ],
  },
  gemini: {
    state: "ready",
    models: [
      { value: "", label: "Auto (default)", description: null, isDefault: true },
      { value: "flash", label: "Flash", description: null, isDefault: false },
    ],
  },
  antigravity: {
    state: "ready",
    models: [
      { value: "", label: "Auto (default)", description: null, isDefault: true },
      { value: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", description: null, isDefault: false },
    ],
  },
};

describe("ModelField", () => {
  it("renders one grouped model selector for every assistant", () => {
    const labels: Record<ChatDefinitionId, string> = {
      claude: "Claude Code",
      codex: "OpenAI Codex",
      gemini: "Gemini CLI",
      antigravity: "Google Antigravity CLI",
    };
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <ModelField
          definitionId="codex"
          definitionIds={["codex", "claude", "gemini"]}
          cliLabel={(id) => labels[id]}
          value="gpt-5.6-sol"
          models={models}
          loadModels={vi.fn()}
          onChange={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup.match(/<select/g)).toHaveLength(1);
    expect(markup).toContain("OpenAI Codex");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Gemini CLI");
    expect(markup).toContain("GPT-5.6-Sol");
    expect(markup).toContain("Sonnet");
    expect(markup).toContain("Flash");
  });

  it("round-trips the assistant and model without delimiter ambiguity", () => {
    const encoded = encodeModelSelection({ definitionId: "gemini", model: "gemini:flash/2" });
    expect(decodeModelSelection(encoded)).toEqual({
      definitionId: "gemini",
      model: "gemini:flash/2",
    });
    expect(decodeModelSelection("not-json")).toBeNull();
  });

  it.each(["codex", "claude", "gemini", "antigravity"] as const)("round-trips %s including its default model", (definitionId) => {
    for (const model of ["", "model:with/delimiters"]) {
      expect(decodeModelSelection(encodeModelSelection({ definitionId, model })))
        .toEqual({ definitionId, model });
    }
    expect(decodeModelSelection('["unknown-cli","model"]')).toBeNull();
  });

  it("can lock only incompatible choices while preserving other assistants", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <ModelField
          definitionId="codex"
          definitionIds={["codex", "claude"]}
          cliLabel={(id) => id}
          value="gpt-5.6-sol"
          models={models}
          loadModels={vi.fn()}
          isSelectionDisabled={({ definitionId, model }) =>
            definitionId === "codex" && model !== "gpt-5.6-sol"
          }
          onChange={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('value="[&quot;codex&quot;,&quot;&quot;]" disabled=""');
    expect(markup).toContain('value="[&quot;claude&quot;,&quot;sonnet&quot;]"');
  });

  it("shows only reported effort levels and escapes the CLI description", () => {
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <ModelField definitionId="codex" definitionIds={["codex"]} cliLabel={id => id}
        value="" models={{ ...models, codex: { state: "ready", models: [{
          value: "default-model", label: "Default", isDefault: true,
          description: "<script>not markup</script>", efforts: [{ value: "high", description: null }],
        }] } }} loadModels={vi.fn()} onChange={vi.fn()} />
    </I18nProvider>);
    expect(markup).toContain("推理強度：high");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("不依模型名稱推測");
  });

  it.each(["loading", "unavailable", "unknown-model"])("keeps capabilities unknown for %s", state => {
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <ModelField definitionId="codex" definitionIds={["codex"]} cliLabel={id => id}
        value="vision-search-pro" models={{ ...models, codex: state === "loading"
          ? { state: "loading" } : state === "unavailable"
            ? { state: "unavailable", reason: "offline" } : models.codex }}
        loadModels={vi.fn()} onChange={vi.fn()} />
    </I18nProvider>);
    expect(markup).toContain("推理強度：尚未確認");
    expect(markup).toContain("CLI 未提供能力資訊");
  });

  it.each([true, false])("shows reported image support (%s) and service tiers", supportsImages => {
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW">
      <ModelField definitionId="codex" definitionIds={["codex"]} cliLabel={id => id}
        value="reported" models={{ ...models, codex: { state: "ready", models: [{
          value: "reported", label: "Reported", isDefault: true, description: null,
          inputModalities: supportsImages ? ["text", "image"] : ["text"], serviceTiers: ["fast"],
        }] } }} loadModels={vi.fn()} onChange={vi.fn()} />
    </I18nProvider>);
    expect(markup).toContain(`圖片輸入：${supportsImages ? "支援" : "不支援"}（CLI 回報）`);
    expect(markup).toContain("服務等級：fast");
    expect(markup).toContain("搜尋：尚未確認");
  });
});
