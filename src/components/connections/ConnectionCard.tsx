/**
 * One connection card.
 *
 * The card body opens the details panel; the star and the action buttons sit
 * above it as siblings, so nothing is nested inside another control. When the
 * current package has no matching session engine, the card states the exact
 * platform boundary instead of offering a button that cannot work.
 */

import {
  connectionTarget,
  isRelayProfile,
  findProtocol,
  type ConnectionProfile,
} from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { EnvironmentBadge, ProtocolTile, TagChip } from "../common/Badge";
import {
  ChevronRightIcon,
  DuplicateIcon,
  EditIcon,
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
  onDatabases,
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
  onDatabases?: () => void;
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
  const linkedNames = [...new Set(linked.map((route) => route.profile.name))]
    .filter((name) => name !== profile.name);

  return (
    <li
      className={`connection-card glass glass--sheen${selected ? " is-selected" : ""}`}
    >
      <button
        type="button"
        className="connection-card__open"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={t("row.details", { name: profile.name })}
        title={[profile.name, connectionTarget(profile), ...profile.tags].join("\n")}
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
          {linkedNames.length > 0 && (
            <span className="connection-card__target">
              {t("row.sameMachine", {
                names: linkedNames.join("、"),
              })}
            </span>
          )}
        </span>
      </div>

      <div className="connection-card__meta">
        <EnvironmentBadge environment={profile.environment} />
        {protocols.map((routeProtocol) => (
          <span key={routeProtocol} className="badge tone-neutral">
            {findProtocol(routeProtocol).acronym}
          </span>
        ))}
      </div>

      <div className="connection-card__primary">
        {linked.length > 0 && connectable.length > 0 ? (
          <span className="connection-card__routes">
            {connectable.map((route) => (
              <button
                key={route.profile.id}
                type="button"
                className="button button--secondary connection-card__route"
                onClick={route.onConnect}
                aria-label={t("row.connectVia", {
                  name: route.profile.name,
                  protocol: findProtocol(route.profile.protocol).acronym,
                }) + ` · ${connectionTarget(route.profile)}`}
                title={connectionTarget(route.profile)}
              >
                <span className="connection-card__route-info">
                  <span className="connection-card__route-protocol">
                    {findProtocol(route.profile.protocol).acronym}
                  </span>
                  <span className="connection-card__route-target mono">
                    {isRelayProfile(route.profile)
                      ? connectionTarget(route.profile)
                      : `${route.profile.hostname}:${route.profile.port}`}
                  </span>
                </span>
                <span className="connection-card__route-action">
                  {t("row.connect")}
                  <ChevronRightIcon size={14} />
                </span>
              </button>
            ))}
          </span>
        ) : onConnect ? (
          <button
            type="button"
            className="button button--primary button--sm connection-card__go"
            onClick={onConnect}
          >
            <TerminalIcon size={13} />
            {t("row.connect")}
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
      </div>

      <div className="connection-card__foot">
        {onDatabases && <button type="button" className="button button--secondary button--sm" title="設定此主機的資料庫，可新增多個種類與版本" onClick={onDatabases}>資料庫設定</button>}
        {onAddRoute && (
          <button
            type="button"
            className="button button--ghost button--sm connection-card__add-route"
            onClick={onAddRoute}
          >
            <PlusIcon size={13} />
            {t("form.route.add")}
          </button>
        )}
        <div className="connection-card__actions">
          <button
            type="button"
            className="icon-button icon-button--sm"
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
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={onEdit}
            aria-label={t("row.edit", { name: profile.name })}
            data-tooltip={t("common.edit")}
          >
            <EditIcon size={14} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={onDuplicate}
            aria-label={t("row.duplicate", { name: profile.name })}
            data-tooltip={t("common.duplicate")}
          >
            <DuplicateIcon size={14} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--sm icon-button--danger"
            onClick={onDelete}
            aria-label={t("row.delete", { name: profile.name }) + (linked.length > 0 ? ` · ${t("confirm.delete.choose")}` : "")}
            data-tooltip={linked.length > 0 ? t("confirm.delete.choose") : t("common.delete")}
          >
            <TrashIcon size={14} />
          </button>
        </div>
      </div>
      {profile.tags.length > 0 && (
        <div className="connection-card__tags">
          {profile.tags.map((tag) => (
            <TagChip key={tag} label={tag} />
          ))}
        </div>
      )}
    </li>
  );
}
