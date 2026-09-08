export type AppLifecycleOwner = "editor" | "update";

export interface AppLifecycleLease {
  release: () => void;
}

/**
 * Synchronous, process-window-local exclusion. Neither React render/effect
 * timing nor a provider's lifetime may allow installation to overlap a draft.
 */
export class AppLifecycleGuard {
  private current: { owner: AppLifecycleOwner; token: symbol } | null = null;

  get owner(): AppLifecycleOwner | null {
    return this.current?.owner ?? null;
  }

  acquire(owner: AppLifecycleOwner): AppLifecycleLease | null {
    if (this.current) return null;
    const token = Symbol(owner);
    this.current = { owner, token };
    return {
      release: () => {
        if (this.current?.token === token) this.current = null;
      },
    };
  }
}

export const appLifecycleGuard = new AppLifecycleGuard();
