/**
 * Resource sidebar: search plus the facets that narrow the connection list.
 *
 * Facets are toggle buttons with `aria-pressed`, so their state reaches
 * assistive technology and not only the eye.
 */

import { forwardRef, useCallback, useRef } from "react";
import {
  environmentCatalog,
  environmentLabelKey,
  findProtocol,
  protocolCatalog,
  tagKey,
  UNGROUPED,
  type Environment,
  type Protocol,
} from "../../domain/connection";
import type { ConnectionFilter, ConnectionGroup } from "../../domain/query";
import { useI18n } from "../../i18n/context";
import { ProtocolIcon } from "../common/Badge";
import { CloseIcon, SearchIcon, StarIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

export const ResourceSidebar = forwardRef<
  HTMLInputElement,
  {
    filter: ConnectionFilter;
    onFilterChange: (filter: ConnectionFilter) => void;
    onReset: () => void;
    filterActive: boolean;
    groups: ConnectionGroup[];
    tags: string[];
    totalCount: number;
    favoriteCount: number;
    visibleCount: number;
    mobileOpen?: boolean;
    onMobileClose?: () => void;
  }
>(function ResourceSidebar(
  {
    filter,
    onFilterChange,
    onReset,
    filterActive,
    groups,
    tags,
    totalCount,
    favoriteCount,
    visibleCount,
    mobileOpen = false,
    onMobileClose,
  },
  searchRef,
) {
  const { t } = useI18n();
  const sidebarRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const setSearchInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      searchInputRef.current = node;
      if (typeof searchRef === "function") searchRef(node);
      else if (searchRef) searchRef.current = node;
    },
    [searchRef],
  );

  useModalFocus({
    dialogRef: sidebarRef,
    getInitialFocus: () => searchInputRef.current,
    onEscape: onMobileClose,
    active: mobileOpen,
  });

  const patch = (next: Partial<ConnectionFilter>) =>
    onFilterChange({ ...filter, ...next });

  const sidebar = (
    <aside
      ref={sidebarRef}
      id="resource-sidebar"
      className="sidebar glass glass--sheen"
      role={mobileOpen ? "dialog" : undefined}
      aria-modal={mobileOpen || undefined}
      aria-labelledby={mobileOpen ? "resource-sidebar-title" : undefined}
      tabIndex={mobileOpen ? -1 : undefined}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {mobileOpen && (
        <header className="sidebar__mobile-head">
          <h2 id="resource-sidebar-title">{t("connections.filters")}</h2>
          <button
            type="button"
            className="icon-button icon-button--sm"
            onClick={onMobileClose}
            aria-label={t("common.close")}
          >
            <CloseIcon size={14} />
          </button>
        </header>
      )}
      <div className="sidebar__search">
        <span className="sidebar__search-icon" aria-hidden="true">
          <SearchIcon size={15} />
        </span>
        <input
          ref={setSearchInputRef}
          type="search"
          value={filter.search}
          onChange={(event) => patch({ search: event.currentTarget.value })}
          placeholder={t("connections.searchPlaceholder")}
          aria-label={t("a11y.searchConnections")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {filter.search && (
          <button
            type="button"
            className="sidebar__search-clear"
            onClick={() => patch({ search: "" })}
            aria-label={t("connections.clearSearch")}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      <div className="sidebar__scroll">
        <section className="sidebar__section">
          <button
            type="button"
            className={`sidebar__row${
              !filter.favoritesOnly && filter.group === null ? " is-active" : ""
            }`}
            onClick={() => patch({ favoritesOnly: false, group: null })}
          >
            <span className="truncate">{t("connections.all")}</span>
            <span className="sidebar__count">{totalCount}</span>
          </button>
          <button
            type="button"
            className={`sidebar__row${filter.favoritesOnly ? " is-active" : ""}`}
            aria-pressed={filter.favoritesOnly}
            onClick={() => patch({ favoritesOnly: !filter.favoritesOnly })}
          >
            <span className="sidebar__row-icon">
              <StarIcon size={14} filled={filter.favoritesOnly} />
            </span>
            <span className="truncate">{t("connections.favorites")}</span>
            <span className="sidebar__count">{favoriteCount}</span>
          </button>
        </section>

        {groups.length > 0 && (
          <section className="sidebar__section">
            <h2 className="sidebar__heading eyebrow">
              {t("connections.groups")}
            </h2>
            {groups.map((group) => (
              <button
                type="button"
                key={group.name}
                className={`sidebar__row${
                  filter.group === group.name ? " is-active" : ""
                }`}
                aria-pressed={filter.group === group.name}
                onClick={() =>
                  patch({
                    group: filter.group === group.name ? null : group.name,
                  })
                }
              >
                <span className="truncate">
                  {group.name === UNGROUPED
                    ? t("connections.ungrouped")
                    : group.name}
                </span>
                <span className="sidebar__count">{group.profiles.length}</span>
              </button>
            ))}
          </section>
        )}

        <section className="sidebar__section">
          <h2 className="sidebar__heading eyebrow">
            {t("connections.protocols")}
          </h2>
          <div className="sidebar__chips">
            {protocolCatalog.map((protocol) => {
              const pressed = filter.protocols.includes(protocol.id);
              return (
                <button
                  type="button"
                  key={protocol.id}
                  className={`filter-chip protocol-${protocol.id}${
                    pressed ? " is-on" : ""
                  }`}
                  aria-pressed={pressed}
                  onClick={() =>
                    patch({
                      protocols: toggle<Protocol>(filter.protocols, protocol.id),
                    })
                  }
                >
                  <ProtocolIcon protocol={protocol.id} size={12} />
                  {findProtocol(protocol.id).acronym}
                </button>
              );
            })}
          </div>
        </section>

        <section className="sidebar__section">
          <h2 className="sidebar__heading eyebrow">
            {t("connections.environments")}
          </h2>
          <div className="sidebar__chips">
            {environmentCatalog.map((environment) => {
              const pressed = filter.environments.includes(environment);
              return (
                <button
                  type="button"
                  key={environment}
                  className={`filter-chip env-${environment}${
                    pressed ? " is-on" : ""
                  }`}
                  aria-pressed={pressed}
                  onClick={() =>
                    patch({
                      environments: toggle<Environment>(
                        filter.environments,
                        environment,
                      ),
                    })
                  }
                >
                  <span className="badge__dot" aria-hidden="true" />
                  {t(environmentLabelKey(environment))}
                </button>
              );
            })}
          </div>
        </section>

        {tags.length > 0 && (
          <section className="sidebar__section">
            <h2 className="sidebar__heading eyebrow">
              {t("connections.tags")}
            </h2>
            <div className="sidebar__chips">
              {tags.map((tag) => {
                const key = tagKey(tag);
                const pressed = filter.tags.some((entry) => tagKey(entry) === key);
                return (
                  <button
                    type="button"
                    key={key}
                    className={`filter-chip${pressed ? " is-on" : ""}`}
                    aria-pressed={pressed}
                    onClick={() => patch({
                      tags: pressed
                        ? filter.tags.filter((entry) => tagKey(entry) !== key)
                        : [...filter.tags, tag],
                    })}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {filterActive && (
        <div className="sidebar__footer">
          <span className="sidebar__result" aria-live="polite">
            {t("connections.shown", { visible: visibleCount, total: totalCount })}
          </span>
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={onReset}
          >
            {t("connections.resetFilters")}
          </button>
        </div>
      )}
    </aside>
  );

  if (!mobileOpen) return sidebar;

  return (
    <div
      className="scrim resource-sidebar-scrim"
      role="presentation"
      onMouseDown={onMobileClose}
    >
      {sidebar}
    </div>
  );
});
