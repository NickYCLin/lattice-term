import { useState } from "react";
import type { ConnectionProfile } from "../../domain/connection";
import { DatabaseManager } from "./DatabaseManager";

/** One mounted workspace survives switching between terminal and chat views. */
export function DatabaseDock({ profiles, open, visible, onClose, onConfigure, catalogRevision = 0 }: {
  profiles: ConnectionProfile[]; open: boolean; visible: boolean; onClose: () => void;
  onConfigure?: (profileId?: string, hostKey?: string) => void; catalogRevision?: number;
}) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return <aside className="database-dock glass" hidden={!open || !visible} aria-label="工作區 SQL 資料庫">
    <header className="database-dock__header"><div><strong>SQL 資料庫</strong><p>與對話、工作階段並排查詢</p></div><button type="button" className="button button--secondary" title="收合資料庫面板，保留草稿與查詢結果" onClick={onClose}>收合</button></header>
    <div className="database-dock__body">{opened && <DatabaseManager profiles={profiles} embedded onClose={onClose} onConfigure={onConfigure} catalogRevision={catalogRevision} />}</div>
  </aside>;
}
