import type { DatabaseProfile } from "../../domain/database";
import { databaseEngines } from "../../domain/database";

export function DatabaseConnectionCard({ profile, remoteName, onOpen, onEdit }: {
  profile: DatabaseProfile; remoteName?: string; onOpen: () => void; onEdit: () => void;
}) {
  return <li className="database-connection-card glass">
    <div className="database-connection-card__heading"><span className="database-connection-card__icon" aria-hidden="true">SQL</span><div><h3>{profile.name}</h3><p>{databaseEngines.find(engine => engine.value === profile.engine)?.label}</p></div></div>
    <p className="database-connection-card__target">{profile.engine === "sqlite" ? profile.sqlitePath : `${profile.hostname}:${profile.port} / ${profile.database}`}</p>
    <p className="database-connection-card__relation">{remoteName ? `與「${remoteName}」放在一起，可直接查詢` : "資料庫專用 · 不需要遠端連線"}</p>
    <div className="database-connection-card__actions"><button type="button" className="button button--primary" onClick={onOpen}>開啟 SQL</button><button type="button" className="button button--secondary" onClick={onEdit}>連線設定</button></div>
  </li>;
}
