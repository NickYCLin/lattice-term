import { useI18n } from "../../i18n/context";
import { useState } from "react";
import type { ConnectionProfile } from "../../domain/connection";
import { DatabaseManager } from "./DatabaseManager";

/** One mounted workspace survives switching between terminal and chat views. */
export function DatabaseDock({ profiles, open, visible, onClose, onConfigure, catalogRevision = 0 }: {
  profiles: ConnectionProfile[]; open: boolean; visible: boolean; onClose: () => void;
  onConfigure?: (profileId?: string, hostKey?: string) => void; catalogRevision?: number;
}) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return <aside className="database-dock glass" hidden={!open || !visible} aria-label={t("database.dockLabel")}>
    <header className="database-dock__header"><div><strong>{t("database.dockTitle")}</strong><p>{t("database.dockHint")}</p></div><button type="button" className="button button--secondary" title={t("database.collapseDockHint")} onClick={onClose}>{t("database.collapse")}</button></header>
    <div className="database-dock__body">{opened && <DatabaseManager profiles={profiles} embedded onClose={onClose} onConfigure={onConfigure} catalogRevision={catalogRevision} />}</div>
  </aside>;
}
