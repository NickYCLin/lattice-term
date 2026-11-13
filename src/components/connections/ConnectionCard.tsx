/**
 * One connection card.
 *
 * The card body opens the details panel; the star and the action buttons sit
 * above it as siblings, so nothing is nested inside another control. When the
 * current package has no matching session engine, the card states the exact
 * platform boundary instead of offering a button that cannot work.
 */

import { useRef } from "react";
import {
  connectionTarget,
  findProtocol,
  type ConnectionProfile,
} from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { EnvironmentBadge, ProtocolTile, TagChip } from "../common/Badge";
import {
  DuplicateIcon,
  EditIcon,
  MoreIcon,
  PlusIcon,
  StarIcon,
  TerminalIcon,
  TrashIcon,
} from "../icons";

export type ConnectionUnavailableReason =
  | "desktop-only"
  | "backend-required"
  | "runtime-unsupported";

/** Another route to the same computer, folded into this card. */
export interface LinkedRoute {
  profile: ConnectionProfile;
  onConnect?: () => void;
}

export function ConnectionCard({
  profile,
  linked = [],
  selected,
  onSelect,
  onEdit,
  onAddRoute,
  onChooseRoute,
  onMerge,
  onDatabases,
  onOpenSql,
  databaseCount = 0,
  databaseNames = [],
  onDuplicate,
  onDelete,
  onToggleFavorite,
  onConnect,
  unavailableReason,
}: {
  profile: ConnectionProfile;
  linked?: LinkedRoute[];
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onAddRoute?: () => void;
  onChooseRoute?: () => void;
  onMerge?: () => void;
  onDatabases?: () => void;
  onOpenSql?: () => void;
  databaseCount?: number;
  databaseNames?: string[];
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
  /** Provided only for protocols that can actually open a session today. */
  onConnect?: () => void;
  unavailableReason?: ConnectionUnavailableReason;
}) {
  const { t } = useI18n();
  const routes: LinkedRoute[] = [{ profile, onConnect }, ...linked];
  const connectable = routes.filter((route) => route.onConnect);
  const protocols = [...new Set(routes.map((route) => route.profile.protocol))];
  const tags = [...new Set(routes.flatMap((route) => route.profile.tags))];
  const management = useRef<HTMLDetailsElement>(null);
  const managementToggle = useRef<HTMLElement>(null);
  const manage = (action: () => void) => () => {
    management.current?.removeAttribute("open");
    managementToggle.current?.focus();
    action();
  };

  return (
    <li
      className={`connection-card glass glass--sheen${databaseCount > 0 ? " connection-card--database" : ""}${selected ? " is-selected" : ""}`}
    >
      <button
        type="button"
        className="connection-card__open"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={t("row.details", { name: profile.name })}
        title={[profile.name, connectionTarget(profile), ...tags].join("\n")}
      />

      <div className="connection-card__head">
        <ProtocolTile protocol={profile.protocol} size="sm" />
        <span className="connection-card__text">
          <span className="connection-card__name" title={profile.name}>
            {profile.name}
          </span>
          <span className="connection-card__target mono" title={connectionTarget(profile)}>
            {connectionTarget(profile)}
          </span>
        </span>
      </div>

      <div className="connection-card__meta">
        <EnvironmentBadge environment={profile.environment} />
        {protocols.map((routeProtocol) => (
          <span key={routeProtocol} className="badge tone-neutral">
            {findProtocol(routeProtocol).acronym}
          </span>
        ))}
        {databaseCount > 0 && <span className="badge tone-neutral">SQL{databaseCount > 1 ? ` · ${databaseCount}` : ""}</span>}
        {databaseNames.length > 0 && <span className="connection-card__database-names" title={databaseNames.join(t("database.nameSeparator"))}>{t("database.cardNames", { names: databaseNames.join(t("database.nameSeparator")) })}</span>}
      </div>

      {tags.length > 0 && (
        <div className="connection-card__tags">
          {tags.map((tag) => (
            <TagChip key={tag} label={tag} />
          ))}
        </div>
      )}

      <div className="connection-card__primary">
        {connectable.length > 0 ? (
          <button
            type="button"
            className="button button--primary button--sm connection-card__go"
            onClick={routes.length > 1 ? onChooseRoute : onConnect}
            aria-haspopup={routes.length > 1 ? "dialog" : undefined}
          >
            <TerminalIcon size={13} />
            {databaseCount > 0 ? t("database.connectRemote") : t("row.connect")}
          </button>
        ) : (
          <span
            className="connection-card__connect"
            title={t(
              unavailableReason === "desktop-only"
                ? "row.connectDesktopOnlyHint"
                : unavailableReason === "backend-required"
                  ? "row.connectBackendRequiredHint"
                  : "row.connectRuntimeUnsupportedHint",
            )}
          >
            {t("row.connect")} ·{" "}
            {t(
              unavailableReason === "desktop-only"
                ? "row.connectDesktopOnly"
                : unavailableReason === "backend-required"
                  ? "row.connectBackendRequired"
                  : "row.connectRuntimeUnsupported",
            )}
          </span>
        )}
        {onOpenSql && <button type="button" className="button button--secondary button--sm" onClick={onOpenSql}>{databaseCount > 1 ? t("database.openSqlCount", { count: databaseCount }) : t("database.openSql")}</button>}
        <button
          type="button"
          className="icon-button icon-button--sm connection-card__favorite"
          onClick={onToggleFavorite}
          aria-pressed={profile.favorite}
          aria-label={
            profile.favorite
              ? t("row.removeFavorite", { name: profile.name })
              : t("row.addFavorite", { name: profile.name })
          }
        >
          <StarIcon
            size={15}
            filled={profile.favorite}
            className={profile.favorite ? "is-favorite" : undefined}
          />
        </button>
        {linked.length > 0 && <span className="connection-card__route-count">{t("row.routeCount", { count: routes.length })}</span>}
      </div>

      <details className="connection-card__management" ref={management}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          management.current?.removeAttribute("open");
          managementToggle.current?.focus();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) management.current?.removeAttribute("open");
        }}>
        <summary className="icon-button icon-button--sm connection-card__more" ref={managementToggle}
          aria-label={t("row.actions", { name: profile.name })} title={t("row.actions", { name: profile.name })}>
          <MoreIcon size={16} />
        </summary>
        <div className="connection-card__foot">
          {onAddRoute && <button type="button" className="button button--ghost button--sm connection-card__add-route" onClick={manage(onAddRoute)}><PlusIcon size={13} />{t("form.route.add")}</button>}
          {onMerge && <button type="button" className="button button--ghost button--sm connection-card__merge" onClick={manage(onMerge)}>{t("connections.merge.action")}</button>}
          {onDatabases && <button type="button" className="button button--ghost button--sm" title={t("database.relatedHint")} onClick={manage(onDatabases)}>{t("database.related")}</button>}
          <div className="connection-card__actions">
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={manage(onEdit)}
              aria-label={t("row.edit", { name: profile.name })}
              data-tooltip={t("common.edit")}
            >
              <EditIcon size={14} />
              {t("common.edit")}
            </button>
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={manage(onDuplicate)}
              aria-label={t("row.duplicate", { name: profile.name })}
              data-tooltip={t("common.duplicate")}
            >
              <DuplicateIcon size={14} />
              {t("common.duplicate")}
            </button>
            <button
              type="button"
              className="button button--ghost button--sm connection-card__delete"
              onClick={manage(onDelete)}
              aria-label={t("row.delete", { name: profile.name }) + (linked.length > 0 ? ` · ${t("confirm.delete.choose")}` : "")}
              data-tooltip={linked.length > 0 ? t("confirm.delete.choose") : t("common.delete")}
            >
              <TrashIcon size={14} />
              {t("common.delete")}
            </button>
          </div>
        </div>
      </details>
    </li>
  );
}
