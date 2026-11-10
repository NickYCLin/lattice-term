import { useMemo, useRef, useState } from "react";
import type { CliProxyModel } from "../../app/cliProxyApi";
import { cliProxyCatalogByVendor, type CliProxyModelCapability } from "../../app/cliProxyModelCatalog";
import { useI18n } from "../../i18n/context";
import type { MessageKey } from "../../i18n/messages/zh-TW";
import { useModalFocus } from "../overlays/modalFocus";

const CAPABILITY_ORDER: readonly CliProxyModelCapability[] = ["text", "image", "video", "audio", "embedding"];
const CAPABILITY_LABEL: Record<CliProxyModelCapability, MessageKey> = {
  text: "settings.cliProxy.capability.text",
  image: "settings.cliProxy.capability.image",
  video: "settings.cliProxy.capability.video",
  audio: "settings.cliProxy.capability.audio",
  embedding: "settings.cliProxy.capability.embedding",
};

/** Every model one proxy reported, grouped by maker and tagged by purpose. */
export function CliProxyModelsDialog({ proxyName, models, onClose }: {
  proxyName: string;
  models: readonly CliProxyModel[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<CliProxyModelCapability | "all">("all");
  useModalFocus({ dialogRef, getInitialFocus: () => closeRef.current, onEscape: onClose });

  const catalog = useMemo(() => cliProxyCatalogByVendor(models), [models]);
  const counts = useMemo(() => {
    const result = new Map<CliProxyModelCapability, number>();
    for (const group of catalog) for (const entry of group.models) {
      result.set(entry.capability, (result.get(entry.capability) ?? 0) + 1);
    }
    return result;
  }, [catalog]);
  const visible = catalog
    .map(group => ({ ...group, models: group.models.filter(entry => filter === "all" || entry.capability === filter) }))
    .filter(group => group.models.length > 0);

  return (
    <div className="scrim scrim--center" role="presentation" onMouseDown={onClose}>
      <div ref={dialogRef} className="dialog dialog--wide cli-proxy-models-dialog" role="dialog" aria-modal="true"
        aria-labelledby="cli-proxy-models-title" tabIndex={-1} onMouseDown={event => event.stopPropagation()}>
        <h2 className="dialog__title" id="cli-proxy-models-title">
          {t("settings.cliProxy.modelsTitle", { name: proxyName, count: models.length })}
        </h2>
        <p className="dialog__body">{t("settings.cliProxy.capabilityGuess")}</p>
        <div className="cli-proxy-models-dialog__filters" role="group" aria-label={t("settings.cliProxy.capabilityFilter")}>
          <button type="button" className="button button--ghost button--sm" aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}>{t("settings.cliProxy.capability.all", { count: models.length })}</button>
          {CAPABILITY_ORDER.filter(capability => counts.has(capability)).map(capability => (
            <button key={capability} type="button" className="button button--ghost button--sm" aria-pressed={filter === capability}
              onClick={() => setFilter(capability)}>{t(CAPABILITY_LABEL[capability])} {counts.get(capability)}</button>
          ))}
        </div>
        <div className="cli-proxy-models-dialog__list">
          {visible.map(group => (
            <section key={group.vendor ?? ""} className="cli-proxy-models-dialog__vendor">
              <h3>{group.vendor ?? t("settings.cliProxy.vendorOther")} <span>{group.models.length}</span></h3>
              <ul>
                {group.models.map(({ model, capability }, index) => (
                  <li key={`${model.id}:${model.ownedBy ?? ""}:${index}`}>
                    <code>{model.id}</code>
                    <span className={`cli-proxy-models-dialog__tag cli-proxy-models-dialog__tag--${capability}`}>
                      {t(CAPABILITY_LABEL[capability])}</span>
                    {model.ownedBy && <small>{model.ownedBy}</small>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="dialog__actions">
          <button ref={closeRef} type="button" className="button button--primary" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
