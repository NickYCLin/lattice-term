/**
 * One connection card.
 *
 * The card body opens the details panel; the star and the action buttons sit
 * above it as siblings, so nothing is nested inside another control. When the
 * current package has no matching session engine, the card states the exact
 * platform boundary instead of offering a button that cannot work.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { handleMenuNavigation } from "../overlays/menuNavigation";
import {
  connectionTarget,
  findProtocol,
  uniqueTags,
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
  jumpOptions = [],
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
  jumpOptions?: { key: string; label: string; connect?: () => void }[];
}) {
  const { t } = useI18n();
  const [jumpChoice, setJumpChoice] = useState("");
  const chosenJump = jumpOptions.find(option => option.key === jumpChoice) ?? jumpOptions[0];
  const routes: LinkedRoute[] = [{ profile, onConnect }, ...linked];
  const connectable = routes.filter((route) => route.onConnect);
  const protocols = [...new Set(routes.map((route) => route.profile.protocol))];
  const tags = uniqueTags(routes.flatMap((route) => route.profile.tags));
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 240, maxHeight: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef<"first" | "last">("first");
  function closeMenu(restoreFocus = true) {
    setMenuOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  }
  function openMenu(last = false) {
    initialFocus.current = last ? "last" : "first";
    setMenuOpen(true);
  }
  const manage = (action: () => void) => () => {
    // Remove the portal before a callback opens another dialog or deletes us.
    flushSync(() => closeMenu());
    action();
  };
  useEffect(() => { setMenuOpen(false); }, [profile.id]);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    function place() {
      const anchor = toggleRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      if (anchor.bottom < 0 || anchor.top > window.innerHeight) { closeMenu(false); return; }
      const margin = 8;
      const width = Math.min(240, Math.max(0, window.innerWidth - margin * 2));
      const below = Math.max(0, window.innerHeight - anchor.bottom - margin - 6);
      const above = Math.max(0, anchor.top - margin - 6);
      const flip = menu.scrollHeight > below && above > below;
      const maxHeight = flip ? above : below;
      setPosition({ width, maxHeight,
        left: Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin)),
        top: flip ? Math.max(margin, anchor.top - Math.min(menu.scrollHeight, maxHeight) - 6) : anchor.bottom + 6,
      });
    }
    place();
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]');
    items?.[initialFocus.current === "last" ? items.length - 1 : 0]?.focus();
    function outside(event: MouseEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !toggleRef.current?.contains(target)) closeMenu();
    }
    document.addEventListener("click", outside, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("click", outside, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [menuOpen]);

  const launchButton = (
    <button
            type="button"
            className="button button--primary button--sm connection-card__go"
            disabled={jumpOptions.length > 0 && !chosenJump?.connect}
            title={databaseCount > 0 ? t("database.connectRemote") : t("row.connect")}
            onClick={jumpOptions.length ? chosenJump?.connect : routes.length > 1 ? onChooseRoute : onConnect}
            aria-haspopup={routes.length > 1 ? "dialog" : undefined}
          >
            <TerminalIcon size={13} />
            {databaseCount > 0 ? t("database.connectRemote") : t("row.connect")}
          </button>
  );

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
        {jumpOptions.length > 0 && <span className="badge tone-neutral">{t("jump.supported")}</span>}
        {protocols.map((routeProtocol) => (
          <span key={routeProtocol} className="badge tone-neutral">
            {findProtocol(routeProtocol).acronym}
          </span>
        ))}
        {databaseCount > 0 && <span className="badge tone-neutral">SQL{databaseCount > 1 ? ` · ${databaseCount}` : ""}</span>}
      </div>

      <div className="connection-card__description">
        {databaseNames.length > 0 && <p className="connection-card__database-names" title={databaseNames.join(t("database.nameSeparator"))}>{t("database.cardNames", { names: databaseNames.join(t("database.nameSeparator")) })}</p>}
        {tags.length > 0 && (
          <div className="connection-card__tags">
            {tags.map((tag) => (
              <TagChip key={tag} label={tag} />
            ))}
          </div>
        )}
      </div>

      <div className="connection-card__primary">
        {connectable.length > 0 ? (
          jumpOptions.length ? <div className="connection-card__launch">{launchButton}
            <label className="connection-card__jump"><span className="visually-hidden">{t("jump.route")}</span>
              <select className="select" aria-label={t("jump.route")} title={chosenJump?.label} value={chosenJump?.key ?? ""} onChange={event => setJumpChoice(event.target.value)}>
                {jumpOptions.map(option => <option key={option.key} value={option.key} disabled={!option.connect}>{option.label}</option>)}
              </select>
            </label>
          </div> : launchButton
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

        {onOpenSql && <button type="button" className="button button--secondary button--sm" title={databaseCount > 1 ? t("database.openSqlCount", { count: databaseCount }) : t("database.openSql")} onClick={onOpenSql}>{databaseCount > 1 ? t("database.openSqlCount", { count: databaseCount }) : t("database.openSql")}</button>}
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
      </div>
      <div className="connection-card__footer" aria-hidden={linked.length === 0 ? true : undefined}>
        {linked.length > 0 && <span className="connection-card__route-count">{t("row.routeCount", { count: routes.length })}</span>}
      </div>

      <div className="connection-card__management">
        <button type="button" className="icon-button icon-button--sm connection-card__more" ref={toggleRef}
          aria-label={t("row.actions", { name: profile.name })} title={t("row.actions", { name: profile.name })}
          aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
          onClick={() => { if (menuOpen) closeMenu(); else openMenu(); }}
          onKeyDown={event => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault(); openMenu(event.key === "ArrowUp" || event.key === "End");
            }
          }}><MoreIcon size={16} /></button>
      </div>
      {menuOpen && createPortal(<div ref={menuRef} id={menuId} className="connection-card__menu"
        role="menu" aria-label={t("row.actions", { name: profile.name })} style={position}
        onKeyDown={event => {
          if (event.key === "Tab") { closeMenu(false); return; }
          handleMenuNavigation(event, closeMenu);
        }}>
        {onAddRoute && <button type="button" role="menuitem" className="connection-card__add-route" onClick={manage(onAddRoute)}><PlusIcon size={14} />{t("form.route.add")}</button>}
        {onMerge && <button type="button" role="menuitem" className="connection-card__merge" onClick={manage(onMerge)}>{t("connections.merge.action")}</button>}
        {onDatabases && <button type="button" role="menuitem" title={t("database.relatedHint")} onClick={manage(onDatabases)}>{t("database.related")}</button>}
        <button type="button" role="menuitem" onClick={manage(onEdit)}><EditIcon size={14} />{t("common.edit")}</button>
        <button type="button" role="menuitem" onClick={manage(onDuplicate)}><DuplicateIcon size={14} />{t("common.duplicate")}</button>
        <button type="button" role="menuitem" className="connection-card__delete" onClick={manage(onDelete)}
          title={linked.length > 0 ? t("confirm.delete.choose") : undefined}><TrashIcon size={14} />{t("common.delete")}</button>
      </div>, document.body)}
    </li>
  );
}
