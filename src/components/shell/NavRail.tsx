/**
 * Global navigation rail.
 *
 * Icon-only to leave the width for real work; every button carries an
 * accessible name and a tooltip, and the current area is named again in the
 * view header, so the rail is never the only place a label appears.
 */

import { useEffect, useState } from "react";
import { MoreIcon } from "../icons";
import { ComposerMenu } from "../chat/ComposerMenu";
import { navigationItems, type NavigationItem, type ViewId } from "../../app/navigation";
import { useI18n } from "../../i18n/context";

export function NavRail({
  current,
  mobile = false,
  onSelect,
  items = navigationItems,
  activityUnreadCount = 0,
  automationUnreadCount = 0,
}: {
  current: ViewId;
  mobile?: boolean;
  onSelect: (view: ViewId) => void;
  items?: NavigationItem[];
  activityUnreadCount?: number;
  automationUnreadCount?: number;
}) {
  const { t } = useI18n();
  const [narrow, setNarrow] = useState(() => mobile && typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 42rem)").matches));
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!mobile || typeof window.matchMedia !== "function") { setNarrow(false); return; }
    const media = window.matchMedia("(max-width: 42rem)");
    const update = () => setNarrow(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [mobile]);
  useEffect(() => { setMoreOpen(false); }, [current, narrow, mobile]);
  const compact = mobile && narrow;
  const primary = new Set<ViewId>(["connections", "terminal", "agents", "settings"]);
  const shown = compact ? items.filter(item => primary.has(item.id)) : items;
  const extra = compact ? items.filter(item => !primary.has(item.id)) : [];
  const moreActive = extra.some(item => item.id === current);
  const moreUnread = extra.some(item => item.id === "activity") ? activityUnreadCount : 0;
  const moreLabel = moreUnread ? t("nav.moreUnread", { count: moreUnread }) : t("nav.more");

  return (
    <nav className={`rail glass glass--sheen${compact ? " rail--compact" : ""}`} aria-label={t("a11y.primaryNav")}>
      <div className="rail__brand" title={t("common.appName")}>
        <img
          src="/app-icon.png"
          alt={t("common.appName")}
          width={28}
          height={28}
          className="rail__brand-img"
        />
        <span className="visually-hidden">{t("common.appName")}</span>
      </div>

      <ul className="rail__items">
        {shown.map((item) => {
          const Glyph = item.icon;
          const active = item.id === current;
          const planned = item.status === "planned";
          const label = t(item.labelKey);
          const visibleLabel = compact && item.id === "agents" ? t("nav.remoteShort") : label;
          const unread = item.id === "activity" ? activityUnreadCount : item.id === "automations" ? automationUnreadCount : 0;
          const accessibleLabel = unread
            ? t(item.id === "automations" ? "automation.navUnread" : "activity.navUnread", { count: unread })
            : label;

          return (
            <li key={item.id}>
              <button
                type="button"
                className={`rail__item${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-label={accessibleLabel}
                onClick={() => onSelect(item.id)}
                data-tooltip={
                  planned
                    ? `${label} · ${t("planned.badge")}`
                    : unread
                      ? accessibleLabel
                      : label
                }
              >
                <Glyph size={19} pulse={active ? item.id : 0} pulseOnMount />
                <span className="rail__label" aria-hidden="true">{visibleLabel}</span>
                <span className="visually-hidden">
                  {planned ? `${label}（${t("planned.badge")}）` : label}
                </span>
                {planned && <span className="rail__flag" aria-hidden="true" />}
                {unread > 0 && (
                  <span className="rail__badge" aria-hidden="true">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {extra.length > 0 && <li aria-current={moreActive ? "page" : undefined}>
          <ComposerMenu label={moreLabel} trigger={<><MoreIcon size={19} pulse={moreActive ? "more" : 0} pulseOnMount /><span className="rail__label" aria-hidden="true">{t("nav.more")}</span>
            {moreUnread > 0 && <span className="rail__badge" aria-hidden="true">{moreUnread > 99 ? "99+" : moreUnread}</span>}</>}
            className={`rail__item${moreActive ? " is-active" : ""}`} disabled={false} open={moreOpen} onOpenChange={setMoreOpen}>
            {close => extra.map(item => { const Glyph = item.icon; const unread = item.id === "activity" ? activityUnreadCount : 0;
              return <button type="button" role="menuitem" key={item.id} className="composer-menu__item rail__more-option" aria-current={current === item.id ? "page" : undefined}
                aria-label={unread ? t("activity.navUnread", { count: unread }) : t(item.labelKey)}
                onClick={() => { close(); onSelect(item.id); }}><Glyph size={19} pulse={current === item.id ? item.id : 0} pulseOnMount /><span>{t(item.labelKey)}</span>
                {unread > 0 && <span aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}</button>;
            })}
          </ComposerMenu>
        </li>}
      </ul>
    </nav>
  );
}
