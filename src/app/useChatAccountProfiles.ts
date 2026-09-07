import { useEffect, useState } from "react";
import { CHAT_ACCOUNT_PROFILES_CHANGED, CHAT_ACCOUNT_PROFILES_KEY, loadChatAccountProfiles } from "./chatAccountProfiles";

export function useChatAccountProfiles() {
  const read = () => typeof localStorage === "undefined" ? [] : loadChatAccountProfiles(localStorage);
  const [profiles, setProfiles] = useState(read);
  useEffect(() => {
    const refresh = () => setProfiles(read());
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === CHAT_ACCOUNT_PROFILES_KEY) refresh();
    };
    window.addEventListener(CHAT_ACCOUNT_PROFILES_CHANGED, refresh);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(CHAT_ACCOUNT_PROFILES_CHANGED, refresh);
      window.removeEventListener("storage", storage);
    };
  }, []);
  return profiles;
}
