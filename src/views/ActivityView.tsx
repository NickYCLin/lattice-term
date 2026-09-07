/** Activity centre for actionable CLI work and the local connection audit log. */

import { useMemo, useState } from "react";
import type { AgentActivityApi } from "../app/useAgentActivity";
import type { Workspace } from "../app/useWorkspace";
import {
  filterAgentActivity,
  type AgentActivityFilter,
  type AgentActivityItem,
  type AgentActivityStatus,
} from "../app/agentActivity";
import {
  activityKindLabelKey,
  activityKindList,
  exportActivityLogText,
  filterActivity,
  type ActivityEntry,
  type ActivityKind,
} from "../domain/activity";
import { useI18n } from "../i18n/context";
import type { MessageKey } from "../i18n/messages/zh-TW";
import { Callout, EmptyState } from "../components/common/Callout";
import { ConfirmDialog } from "../components/overlays/ConfirmDialog";
import {
  ActivityIcon,
  BellIcon,
  ExportIcon,
  SearchIcon,
  TrashIcon,
} from "../components/icons";
import { moveRadioGroupFocus } from "../components/overlays/radioNavigation";

const agentFilterChoices: readonly AgentActivityFilter[] = [
  "all",
  "unread",
  "running",
  "waiting",
];

const activityFilterChoices: readonly (ActivityKind | "all")[] = [
  "all",
  ...activityKindList,
];

const agentStatusLabel: Record<AgentActivityStatus, MessageKey> = {
  running: "activity.agent.status.running",
  waiting: "activity.agent.status.waiting",
  ready: "activity.agent.status.ready",
  idle: "activity.agent.status.idle",
};

const agentFilterLabel: Record<AgentActivityFilter, MessageKey> = {
  all: "activity.agent.filter.all",
  unread: "activity.agent.filter.unread",
  running: "activity.agent.filter.running",
  waiting: "activity.agent.filter.waiting",
};

export function ActivityView({
  workspace,
  agentActivity,
  onOpenAgentActivity,
  mobile = false,
}: {
  workspace: Workspace;
  agentActivity: AgentActivityApi;
  onOpenAgentActivity: (groupId: string, sessionId: string | null) => void;
  mobile?: boolean;
}) {
  const { t, tag } = useI18n();
  const { activity, clearActivity } = workspace;
  const [confirming, setConfirming] = useState<"agent" | "audit" | null>(null);
  const [agentFilter, setAgentFilter] = useState<AgentActivityFilter>("all");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<ActivityKind | "all">("all");

  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(tag, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [tag],
  );

  const visibleAgentActivity = useMemo(
    () => filterAgentActivity(agentActivity.items, agentFilter),
    [agentActivity.items, agentFilter],
  );

  /** Headline for an audit entry: user data if present, otherwise our wording. */
  const title = (entry: ActivityEntry) =>
    entry.subject ?? (entry.titleKey ? t(entry.titleKey) : "");

  const detail = (entry: ActivityEntry) =>
    entry.detail ?? (entry.note ? t(entry.note.key, entry.note.values) : "");

  const searchText = (entry: ActivityEntry) =>
    `${t(activityKindLabelKey(entry.kind))} ${title(entry)} ${detail(entry)}`;

  const visibleAudit = useMemo(
    () => filterActivity(activity, search, kind, searchText),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activity, search, kind, t],
  );
  const auditFiltering = search.trim() !== "" || kind !== "all";

  return (
    <div className="stack">
      {!mobile && <>
      <Callout tone="info" title={t("activity.note.title")}>
        {t("activity.note.body")}
      </Callout>

      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("activity.agent.title")}</h2>
            <p className="panel__hint">
              {agentFilter === "all"
                ? t("activity.agent.count", {
                    count: agentActivity.items.length,
                    unread: agentActivity.unreadCount,
                  })
                : t("activity.agent.countFiltered", {
                    visible: visibleAgentActivity.length,
                    total: agentActivity.items.length,
                  })}
            </p>
          </div>
          <div className="panel__actions">
            {agentActivity.unreadCount > 0 && (
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={agentActivity.markAllRead}
              >
                {t("activity.agent.markAllRead")}
              </button>
            )}
            {agentActivity.items.length > 0 && (
              <button
                type="button"
                className="button button--ghost button--danger button--sm"
                onClick={() => setConfirming("agent")}
              >
                <TrashIcon size={14} />
                {t("activity.agent.clear")}
              </button>
            )}
          </div>
        </header>

        <div
          className="segmented activity-agent-filter"
          role="radiogroup"
          aria-label={t("activity.agent.filterLabel")}
        >
          {agentFilterChoices.map((value, index) => (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={agentFilter === value}
              tabIndex={agentFilter === value ? 0 : -1}
              className={`segmented__option${agentFilter === value ? " is-selected" : ""}`}
              onClick={() => setAgentFilter(value)}
              onKeyDown={(event) =>
                moveRadioGroupFocus(event, index, (nextIndex) =>
                  setAgentFilter(agentFilterChoices[nextIndex]),
                )
              }
            >
              {t(agentFilterLabel[value])}
            </button>
          ))}
        </div>

        {agentActivity.items.length === 0 ? (
          <EmptyState
            icon={<BellIcon size={26} />}
            title={t("activity.agent.empty.title")}
            description={t("activity.agent.empty.body")}
          />
        ) : visibleAgentActivity.length === 0 ? (
          <div className="activity-empty">
            <p>{t("activity.agent.noMatch")}</p>
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={() => setAgentFilter("all")}
            >
              {t("activity.agent.resetFilter")}
            </button>
          </div>
        ) : (
          <ul className="agent-activity-list">
            {visibleAgentActivity.map((item) => (
              <AgentActivityRow
                key={item.groupId}
                item={item}
                time={timeFormat.format(item.updatedAt)}
                onOpen={() =>
                  onOpenAgentActivity(item.groupId, item.sessionId)
                }
              />
            ))}
          </ul>
        )}
      </section>
      </>}

      <section className="panel glass glass--sheen">
        <header className="panel__head">
          <div>
            <h2 className="panel__title">{t("activity.audit.title")}</h2>
            <p className="panel__hint">
              {auditFiltering
                ? t("activity.countFiltered", {
                    visible: visibleAudit.length,
                    total: activity.length,
                  })
                : t("activity.count", { count: activity.length })}
            </p>
          </div>
          {activity.length > 0 && (
            <div className="panel__actions">
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() =>
                  exportLog(
                    exportActivityLogText(
                      activity,
                      (entry) =>
                        `[${t(activityKindLabelKey(entry.kind))}] ${title(entry)}${
                          detail(entry) ? ` (${detail(entry)})` : ""
                        }`,
                    ),
                  )
                }
              >
                <ExportIcon size={14} />
                {t("activity.export")}
              </button>
              <button
                type="button"
                className="button button--ghost button--danger button--sm"
                onClick={() => setConfirming("audit")}
              >
                <TrashIcon size={14} />
                {t("activity.clear")}
              </button>
            </div>
          )}
        </header>

        {activity.length === 0 ? (
          <EmptyState
            icon={<ActivityIcon size={26} />}
            title={t("activity.empty.title")}
            description={t("activity.empty.body")}
          />
        ) : (
          <>
            <div className="activity-toolbar">
              <label className="activity-search">
                <SearchIcon size={14} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  placeholder={t("activity.searchPlaceholder")}
                  aria-label={t("activity.searchPlaceholder")}
                />
              </label>

              <div
                className="segmented"
                role="radiogroup"
                aria-label={t("activity.audit.title")}
              >
                {activityFilterChoices.map((value, index) => (
                  <button
                    type="button"
                    key={value}
                    role="radio"
                    aria-checked={kind === value}
                    tabIndex={kind === value ? 0 : -1}
                    className={`segmented__option${kind === value ? " is-selected" : ""}`}
                    onClick={() => setKind(value)}
                    onKeyDown={(event) =>
                      moveRadioGroupFocus(event, index, (nextIndex) =>
                        setKind(activityFilterChoices[nextIndex]),
                      )
                    }
                  >
                    {value === "all"
                      ? t("activity.filter.all")
                      : t(activityKindLabelKey(value))}
                  </button>
                ))}
              </div>
            </div>

            {visibleAudit.length === 0 ? (
              <div className="activity-empty">
                <p>{t("activity.noMatch")}</p>
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={() => {
                    setSearch("");
                    setKind("all");
                  }}
                >
                  {t("activity.resetFilter")}
                </button>
              </div>
            ) : (
              <ul className="activity-list">
                {visibleAudit.map((entry) => (
                  <li className="activity-row" key={entry.id}>
                    <span className={`activity-row__kind kind-${entry.kind}`}>
                      {t(activityKindLabelKey(entry.kind))}
                    </span>
                    <span className="activity-row__message truncate">
                      {title(entry)}
                    </span>
                    <span className="activity-row__detail mono truncate">
                      {detail(entry)}
                    </span>
                    <time className="activity-row__time mono">
                      {timeFormat.format(entry.at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {confirming === "agent" && (
        <ConfirmDialog
          title={t("activity.agent.confirmClear.title")}
          body={t("activity.agent.confirmClear.body", {
            count: agentActivity.items.length,
          })}
          confirmLabel={t("activity.agent.confirmClear.confirm")}
          cancelLabel={t("common.cancel")}
          onConfirm={() => {
            agentActivity.clear();
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming === "audit" && (
        <ConfirmDialog
          title={t("activity.confirmClear.title")}
          body={t("activity.confirmClear.body", { count: activity.length })}
          confirmLabel={t("activity.confirmClear.confirm", {
            count: activity.length,
          })}
          cancelLabel={t("common.cancel")}
          onConfirm={() => {
            clearActivity();
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function AgentActivityRow({
  item,
  time,
  onOpen,
}: {
  item: AgentActivityItem;
  time: string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const live = item.sessionId !== null;
  return (
    <li>
      <button
        type="button"
        className={`agent-activity-row${item.unread ? " is-unread" : ""}`}
        onClick={onOpen}
      >
        <span className="agent-activity-row__indicator" aria-hidden="true" />
        <span className={`activity-row__kind kind-agent-${item.status}`}>
          {t(agentStatusLabel[item.status])}
        </span>
        <span className="agent-activity-row__content">
          <span className="agent-activity-row__title truncate">
            {item.groupLabel}
          </span>
          <span className="agent-activity-row__meta truncate">
            {item.agentLabels.join(" · ")}
          </span>
        </span>
        <span className="agent-activity-row__path mono truncate">
          {live ? item.workingDirectory : t("activity.agent.notOpen")}
        </span>
        <time className="activity-row__time mono">{time}</time>
      </button>
    </li>
  );
}

function exportLog(content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `latticeterm-activity-${new Date().toISOString().slice(0, 10)}.log`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
