import type { ChatItem } from "./agentChat";

export function proxyChatHistory(items: readonly ChatItem[]) {
  return items.flatMap(item => {
    if (item.type === "user") return [{ role: "user", text: item.text, attachments: (item.attachments ?? []).map(({ path }) => ({ path })) }];
    if (item.type === "text") return [{ role: "assistant", text: item.text, attachments: [] }];
    return [];
  });
}
