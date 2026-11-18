import { DesktopDescription } from "../common/MobilePresentation";
/** Header for the workspace column: area name, context and area actions. */

import type { ReactNode } from "react";
import { useI18n } from "../../i18n/context";
import { SidebarIcon } from "../icons";

export function ViewHeader({
  title,
  description,
  actions,
  onToggleSidebar,
  sidebarCollapsed,
  sidebarIsDialog = false,
  showSidebarToggle = true,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  sidebarIsDialog?: boolean;
  showSidebarToggle?: boolean;
}) {
  const { t } = useI18n();
  const toggleLabel = sidebarCollapsed
    ? t("a11y.toggleSidebar.show")
    : t("a11y.toggleSidebar.hide");

  return (
    <header className="view-header glass glass--sheen">
      {showSidebarToggle && (
        <button
          type="button"
          className="icon-button"
          onClick={onToggleSidebar}
          aria-expanded={!sidebarCollapsed}
          aria-controls="resource-sidebar"
          aria-haspopup={sidebarIsDialog ? "dialog" : undefined}
          aria-label={toggleLabel}
          data-tooltip={toggleLabel}
        >
          <SidebarIcon />
        </button>
      )}

      <div className="view-header__text">
        <h1 className="view-header__title">{title}</h1>
        <DesktopDescription><p className="view-header__description">{description}</p></DesktopDescription>
      </div>

      {actions && <div className="view-header__actions">{actions}</div>}
    </header>
  );
}
