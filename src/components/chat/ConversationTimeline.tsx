import { useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/context";
import type { Exploration } from "../../app/toolPresentation";

export interface TimelineRow {
  id: string; aliases: string[]; user: boolean; process: boolean; steps?: number;
  exploration?: Exploration; endsTurn?: boolean; durationMs?: number | null; node: ReactNode;
}
export function timelineTurns(rows: readonly TimelineRow[], latestFinished: boolean) {
  const turns: { id: string; rows: TimelineRow[]; finished: boolean }[] = [];
  for (const row of rows) {
    if (!turns.length || row.user) turns.push({ id: row.id, rows: [], finished: false });
    turns[turns.length - 1].rows.push(row);
  }
  return turns.map((turn, index) => ({ ...turn, finished: index + 1 < turns.length || turn.rows.some(row => row.endsTurn) || latestFinished }));
}
function Turn({ rows, finished, collapseDefault, match }: { rows: TimelineRow[]; finished: boolean; collapseDefault: boolean; match?: string }) {
  const { t } = useI18n(); const [override, setOverride] = useState<boolean>();
  const [explorationOpen, setExplorationOpen] = useState<Record<string, boolean>>({});
  const processes = rows.filter(row => row.process);
  const found = processes.some(row => match !== undefined && row.aliases.includes(match));
  const collapsed = finished && !found && (override ?? collapseDefault);
  const steps = processes.reduce((sum, row) => sum + (row.steps ?? 1), 0);
  const duration = rows.find(row => row.durationMs != null)?.durationMs;
  const first = processes[0]?.id;
  const groups: TimelineRow[][] = [];
  for (const row of rows) {
    if (row.exploration && row.process && groups[groups.length - 1]?.every(entry => entry.exploration && entry.process)) groups[groups.length - 1].push(row);
    else groups.push([row]);
  }
  const membership = new Map<string, TimelineRow[]>();
  for (const group of groups) if (group.length > 1) for (const row of group) membership.set(row.id, group);
  // Keep every row under its own stable keyed parent. Forming a group as a
  // second command finishes must not remount the first card or reset its scroll.
  return <div className="chat-process-turn">{rows.map(row => {
    const group = membership.get(row.id), groupId = group?.[0].id;
    const groupFound = group?.some(entry => match !== undefined && entry.aliases.includes(match));
    const groupOpen = !finished || groupFound || (groupId && explorationOpen[groupId]) || false;
    const counts = group?.reduce((a, entry) => ({ files: a.files + (entry.exploration?.files ?? 0), searches: a.searches + (entry.exploration?.searches ?? 0), directories: a.directories + (entry.exploration?.directories ?? 0) }), { files: 0, searches: 0, directories: 0 });
    const hideContent = row.process && (collapsed || Boolean(group && !groupOpen));
    const hasHeader = finished && row.id === first || groupId === row.id && !collapsed;
    return <div key={row.id} hidden={hideContent && !hasHeader}>
      {finished && row.id === first && <button className="button button--ghost button--sm chat-process-toggle" type="button"
        aria-expanded={!collapsed} onClick={() => setOverride(!collapsed)}>
        {t(collapsed ? "chat.process.steps" : "chat.process.collapse", { count: steps })}
        {duration != null && <span> · {t("chat.turn.duration", { seconds: (duration / 1000).toFixed(1) })}</span>}
      </button>}
      {groupId === row.id && !collapsed && <button type="button" className="button button--ghost button--sm chat-exploration__toggle"
        aria-expanded={Boolean(groupOpen)} disabled={!finished} onClick={() => setExplorationOpen(current => ({ ...current, [groupId]: !groupOpen }))}>
        <span aria-hidden="true">{groupOpen ? "▾" : "▸"}</span>{t("chat.process.explored", counts)}
      </button>}
      <div hidden={hideContent}>{row.node}</div>
    </div>;
  })}</div>;
}
/** Does not reorder messages, and never hides rows the caller marks protected. */
export function ConversationTimeline({ rows, collapseDefault, latestFinished, match }: {
  rows: TimelineRow[]; collapseDefault: boolean; latestFinished: boolean; match?: string;
}) {
  return <>{timelineTurns(rows, latestFinished).map(turn => <Turn key={turn.id} rows={turn.rows} finished={turn.finished}
    collapseDefault={collapseDefault} match={match} />)}</>;
}
