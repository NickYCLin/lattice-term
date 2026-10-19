/** One model picker across every installed assistant. Choosing a model also
 * chooses the CLI that owns it, so people never have to switch a brand first. */

import { useEffect } from "react";
import { effortChoices, type ChatDefinitionId, type ChatModelList } from "../../app/agentChat";
import { useI18n } from "../../i18n/context";

export interface ChatModelSelection {
  definitionId: ChatDefinitionId;
  model: string;
}

export function encodeModelSelection(selection: ChatModelSelection): string {
  return JSON.stringify([selection.definitionId, selection.model]);
}

export function decodeModelSelection(value: string): ChatModelSelection | null {
  try {
    const selection: unknown = JSON.parse(value);
    if (!Array.isArray(selection) || selection.length !== 2) return null;
    const [definitionId, model] = selection;
    if (
      (definitionId !== "claude" && definitionId !== "codex" && definitionId !== "gemini" && definitionId !== "antigravity") ||
      typeof model !== "string"
    ) {
      return null;
    }
    return { definitionId, model };
  } catch {
    return null;
  }
}

export function ModelField({
  definitionId,
  definitionIds,
  cliLabel,
  value,
  disabled,
  title,
  models,
  loadModels,
  isSelectionDisabled,
  onChange,
}: {
  definitionId: ChatDefinitionId;
  definitionIds: readonly ChatDefinitionId[];
  cliLabel: (definitionId: ChatDefinitionId) => string;
  value: string;
  disabled?: boolean;
  title?: string;
  models: Record<ChatDefinitionId, ChatModelList>;
  loadModels: (definitionId: ChatDefinitionId) => void;
  /** A CLI may keep its model fixed after creating a native session. */
  isSelectionDisabled?: (selection: ChatModelSelection) => boolean;
  onChange: (selection: ChatModelSelection) => void;
}) {
  const { t } = useI18n();
  const available = Array.from(new Set([definitionId, ...definitionIds]));
  const availableKey = available.join("\0");
  const selectedList = models[definitionId];
  const selectedModel = selectedList.state === "ready"
    ? selectedList.models.find(model => value ? model.value === value : model.isDefault)
    : undefined;
  const efforts = effortChoices(definitionId, value, selectedList);

  useEffect(() => {
    for (const id of availableKey.split("\0") as ChatDefinitionId[]) {
      loadModels(id);
    }
  }, [availableKey, loadModels]);

  return (
    <label className="field">
      <span className="field__label">{t("chat.model")}</span>
      <select
        className="select"
        value={encodeModelSelection({ definitionId, model: value })}
        disabled={disabled}
        title={title}
        onChange={(event) => {
          const selection = decodeModelSelection(event.target.value);
          if (selection) onChange(selection);
        }}
      >
        {available.map((id) => {
          const list = models[id];
          const choices = list.state === "ready" ? [...list.models] : [];
          if (!choices.some((model) => model.value === "")) {
            choices.unshift({
              value: "",
              label:
                list.state === "loading"
                  ? t("chat.model.loading")
                  : t("chat.model.default"),
              description: null,
              isDefault: true,
            });
          }
          if (
            id === definitionId &&
            value &&
            !choices.some((model) => model.value === value)
          ) {
            choices.push({
              value,
              label: value,
              description: null,
              isDefault: false,
            });
          }
          return (
            <optgroup key={id} label={cliLabel(id)}>
              {choices.map((model) => (
                <option
                  key={`${id}:${model.value || "default"}`}
                  value={encodeModelSelection({ definitionId: id, model: model.value })}
                  disabled={isSelectionDisabled?.({ definitionId: id, model: model.value })}
                >
                  {model.label}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {selectedModel?.description && <small className="field__hint">{selectedModel.description}</small>}
      <small className="field__hint" role="status">
        {t("chat.model.capabilities.reasoning", {
          levels: efforts.length ? efforts.map(effort => effort.value).join(" / ") : t("chat.model.capabilities.unknown"),
        })}
        {" · "}{t("chat.model.capabilities.unreported")}
      </small>
    </label>
  );
}
