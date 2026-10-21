import { useEffect, useState } from "react";
import type { ChatModelChoice, ChatModelList } from "./agentChat";
import { accountModelTargetKey, hasChatModels, type AccountModelTarget } from "./accountModels";
import { hasDesktopBackend } from "./nativeRuntime";

/** Model discovery is scoped to the actual CLI config root, never just the
 * provider. A model available to account A is not assumed available to B. */
export function useAccountModels(targets: readonly AccountModelTarget[], enabled = true) {
  const [lists, setLists] = useState<Record<string, ChatModelList>>({});
  const targetKey = JSON.stringify(targets.map(({ definitionId, configDirectory, signedOut, accountName }) => ({ definitionId, configDirectory, signedOut, accountName })));
  useEffect(() => {
    if (!enabled || !hasDesktopBackend()) return;
    let disposed = false;
    const requested = new Set<string>();
    const current = JSON.parse(targetKey) as Pick<AccountModelTarget, "definitionId" | "configDirectory" | "signedOut">[];
    setLists({});
    for (const target of current) {
      if (!hasChatModels(target.definitionId) || target.signedOut) continue;
      const key = accountModelTargetKey(target);
      if (requested.has(key)) continue;
      requested.add(key);
      setLists((previous) => ({ ...previous, [key]: { state: "loading" } }));
      import("@tauri-apps/api/core")
        .then(({ invoke }) => disposed ? undefined : invoke<ChatModelChoice[]>("agent_chat_models", { definitionId: target.definitionId, profileConfigPath: target.configDirectory }))
        .then((models) => {
          if (!disposed && models) setLists((previous) => ({ ...previous, [key]: { state: "ready", models } }));
        })
        .catch((reason: unknown) => {
          if (!disposed) setLists((previous) => ({ ...previous, [key]: { state: "unavailable", reason: String(reason) } }));
        });
    }
    return () => { disposed = true; };
  }, [enabled, targetKey]);
  return lists;
}
