import { createContext, useContext, type ReactNode } from "react";
import { isMobilePlatform } from "../../app/navigation";

const MobilePresentationContext = createContext(false);

/** Mirrors app--mobile, including content rendered through React portals. */
export function MobilePresentationProvider({ mobile, platform, children }: { mobile?: boolean; platform?: string; children: ReactNode }) {
  const inherited = useMobilePresentation();
  return <MobilePresentationContext.Provider value={mobile ?? (isMobilePlatform(platform) || inherited)}>{children}</MobilePresentationContext.Provider>;
}

export function useMobilePresentation() {
  return useContext(MobilePresentationContext);
}

/** Opt-in for explanatory copy only. Never wrap errors, warnings or actions. */
export function DesktopDescription({ children, platform }: { children: ReactNode; platform?: string }) {
  const mobile = useMobilePresentation();
  return mobile || isMobilePlatform(platform) ? null : <>{children}</>;
}
