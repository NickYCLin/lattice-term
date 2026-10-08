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
  findProtocol,
  type ConnectionProfile,
} from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { EnvironmentBadge, ProtocolTile, TagChip } from "../common/Badge";
import {
  DuplicateIcon,
  EditIcon,
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
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
  /** Provided only for protocols that can actually open a session today. */
  onConnect?: () => void;
  unavailableReason?: ConnectionUnavailableReason;
}) {
  const { t } = useI18n();
  const protocol = findProtocol(profile.protocol);
  const routes: LinkedRoute[] = [{ profile, onConnect }, ...linked];
  const connectable = routes.filter((route) => route.onConnect);

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
          <span className="connection-card__name truncate" title={profile.name}>
            {profile.name}
          </span>
          <span className="connection-card__target mono truncate" title={connectionTarget(profile)}>
            {connectionTarget(profile)}
          </span>
          {linked.length > 0 && (
            <span className="connection-card__target truncate">
              {t("row.sameMachine", {
                names: linked.map((route) => route.profile.name).join("、"),
              })}
            </span>
          )}
        </span>
      </div>

      <div className="connection-card__meta">
        <EnvironmentBadge environment={profile.environment} />
        <span className="badge tone-neutral">{protocol.acronym}</span>
        {linked.map((route) => (
          <span
            key={route.profile.id}
            className="badge tone-neutral"
            title={route.profile.name}
          >
            {findProtocol(route.profile.protocol).acronym}
          </span>
        ))}
        <span className="connection-card__tags" title={profile.tags.join("、")}>
          {profile.tags.slice(0, 1).map((tag) => (
            <TagChip key={tag} label={tag} />
          ))}
          {profile.tags.length > 1 && (
            <span className="badge badge--tag connection-card__tag-count">
              +{profile.tags.length - 1}
            </span>
          )}
        </span>
      </div>

      <div className="connection-card__primary">
        {linked.length > 0 && connectable.length > 0 ? (
          <span className="connection-card__routes">
            {connectable.map((route) => (
              <button
                key={route.profile.id}
                type="button"
                className="button button--primary button--sm connection-card__go"
                onClick={route.onConnect}
                aria-label={t("row.connectVia", {
                  name: route.profile.name,
                  protocol: findProtocol(route.profile.protocol).acronym,
                })}
                title={connectionTarget(route.profile)}
              >
                <TerminalIcon size={13} />
                {findProtocol(route.profile.protocol).acronym}
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
            aria-label={t("row.delete", { name: profile.name })}
            data-tooltip={t("common.delete")}
          >
            <TrashIcon size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}
