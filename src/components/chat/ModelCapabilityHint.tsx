import type { ChatModelChoice } from "../../app/agentChat";
import { useI18n } from "../../i18n/context";

export function ModelCapabilityHint({ model, levels }: { model?: ChatModelChoice; levels?: readonly string[] }) {
  const { t } = useI18n();
  const efforts = levels ?? model?.efforts?.map(effort => effort.value) ?? [];
  return <>
    {model?.description && <small className="field__hint">{model.description}</small>}
    <small className="field__hint" role="status">
      {t("chat.model.capabilities.reasoning", { levels: efforts.join(" / ") || t("chat.model.capabilities.unknown") })}
      {model?.inputModalities === undefined && model?.serviceTiers === undefined
        ? <> · {t("chat.model.capabilities.unreported")}</>
        : <>
          {" · "}{t("chat.model.capabilities.images", { value: model?.inputModalities === undefined
            ? t("chat.model.capabilities.unknown")
            : t(model.inputModalities.includes("image") ? "chat.model.capabilities.supported" : "chat.model.capabilities.unsupported") })}
          {" · "}{t("chat.model.capabilities.tiers", { value: model?.serviceTiers === undefined
            ? t("chat.model.capabilities.unknown")
            : model.serviceTiers.join(" / ") || t("chat.model.capabilities.none") })}
          {" · "}{t("chat.model.capabilities.searchUnknown")}
        </>}
    </small>
  </>;
}
