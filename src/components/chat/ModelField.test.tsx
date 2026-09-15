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
});
