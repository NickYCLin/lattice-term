import { useEffect, useRef, useState } from "react";
import type { ChatModelChoice, ChatModelList } from "./agentChat";
import { accountModelTargetKey, hasChatModels, type AccountModelTarget } from "./accountModels";
import { hasDesktopBackend } from "./nativeRuntime";

/** Model discovery is scoped to the actual CLI config root, never just the
 * provider. A model available to account A is not assumed available to B. */
export function useAccountModels(targets: readonly AccountModelTarget[], enabled = true) {
  const [lists, setLists] = useState<Record<string, ChatModelList>>({});
  const requested = useRef(new Set<string>());
  const targetKey = JSON.stringify(targets.map(({ definitionId, configDirectory, signedOut }) => ({ definitionId, configDirectory, signedOut })));
  useEffect(() => {
    if (!enabled || !hasDesktopBackend()) return;
    const current = JSON.parse(targetKey) as Pick<AccountModelTarget, "definitionId" | "configDirectory" | "signedOut">[];
    for (const target of current) {
      if (!hasChatModels(target.definitionId) || target.signedOut) continue;
      const key = accountModelTargetKey(target);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      setLists((previous) => ({ ...previous, [key]: { state: "loading" } }));
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<ChatModelChoice[]>("agent_chat_models", { definitionId: target.definitionId, profileConfigPath: target.configDirectory }))
        .then((models) => setLists((previous) => ({ ...previous, [key]: { state: "ready", models } })))
        .catch((reason: unknown) => {
          // Reopening the picker or completing login may retry a transient
          // failure, but never spin on the error in a render loop.
          requested.current.delete(key);
          setLists((previous) => ({ ...previous, [key]: { state: "unavailable", reason: String(reason) } }));
        });
    }
  }, [enabled, targetKey]);
  return lists;
}
