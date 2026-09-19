import { useState } from "react";
import {
  resetUnreadableSharedSidebar,
  useSharedSidebarStorageUnreadable,
} from "../../app/sharedSidebarLayout";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { ConfirmDialog } from "../overlays/ConfirmDialog";

/**
 * Shown while the saved folder tree cannot be read. Folder changes still
 * work on screen but are not saved; the user can set the unreadable copy
 * aside and start saving the tree they see.
 */
export function SidebarStorageNotice() {
  const { t } = useI18n();
  const unreadable = useSharedSidebarStorageUnreadable();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  if (!unreadable) return null;
  return (
    <>
      <Callout
        tone="warn"
        title={t("sidebar.storage.unreadableTitle")}
        actions={
          <button
            type="button"
            className="button button--secondary button--sm"
            onClick={() => setConfirming(true)}
          >
            {t("sidebar.storage.reset")}
          </button>
        }
      >
        {t("sidebar.storage.unreadableBody")}
        {error && <span className="mono">{error}</span>}
      </Callout>
      {confirming && (
        <ConfirmDialog
          title={t("sidebar.storage.resetTitle")}
          body={t("sidebar.storage.resetBody")}
          confirmLabel={t("sidebar.storage.reset")}
          cancelLabel={t("common.cancel")}
          tone="default"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            setError("");
            try {
              resetUnreadableSharedSidebar();
            } catch (reason) {
              setError(String(reason));
            }
          }}
        />
      )}
    </>
  );
}
