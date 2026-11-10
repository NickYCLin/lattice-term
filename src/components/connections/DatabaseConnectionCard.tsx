import { useI18n } from "../../i18n/context";
import type { DatabaseProfile } from "../../domain/database";
import { databaseEngines } from "../../domain/database";

export function DatabaseConnectionCard({ profile, remoteName, onOpen, onEdit }: {
  profile: DatabaseProfile; remoteName?: string; onOpen: () => void; onEdit: () => void;
}) {
  const { t } = useI18n();
  return <li className="database-connection-card glass">
    <div className="database-connection-card__heading"><span className="database-connection-card__icon" aria-hidden="true">SQL</span><div><h3>{profile.name}</h3><p>{databaseEngines.find(engine => engine.value === profile.engine)?.label}</p></div></div>
    <p className="database-connection-card__target">{profile.engine === "sqlite" ? profile.sqlitePath : `${profile.hostname}:${profile.port} / ${profile.database}`}</p>
    <p className="database-connection-card__relation">{remoteName ? t("database.relatedRemote", { name: remoteName }) : t("database.standaloneConnection")}</p>
    <div className="database-connection-card__actions"><button type="button" className="button button--primary" onClick={onOpen}>{t("database.openSql")}</button><button type="button" className="button button--secondary" onClick={onEdit}>{t("database.settings")}</button></div>
  </li>;
}
