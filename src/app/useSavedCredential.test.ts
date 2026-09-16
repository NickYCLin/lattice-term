import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credentialKindFor,
  useSavedCredential,
  type CredentialKind,
  type SavedCredentialState,
} from "./useSavedCredential";
import type { ConnectionProfile } from "../domain/connection";
import { installFakeDom } from "./testFixtures/hookDom";

const backend = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));

function hookContainer(): Element {
  installFakeDom();
  const fakeDocument = globalThis.document as unknown as {
    createElement: (name: string) => Record<string, unknown>;
  };
  const container = fakeDocument.createElement("div");
  container.ownerDocument = fakeDocument;
  return container as unknown as Element;
}

async function mountCredential(kind: CredentialKind) {
  let state: SavedCredentialState | undefined;
  function Harness() {
    state = useSavedCredential("remote-host", kind).state;
    return null;
  }
  const root = createRoot(hookContainer());
  await act(async () => { root.render(createElement(Harness)); });
  await act(async () => {
    await vi.waitFor(() => expect(state?.mode).not.toBe("loading"));
  });
  return { root, state: () => state! };
}

afterEach(() => {
  backend.invoke.mockReset();
});

function profile(protocol: ConnectionProfile["protocol"]): ConnectionProfile {
  return {
    id: "profile-1",
    name: "Example",
    protocol,
    hostname: "example.test",
    username: "operator",
    port: protocol === "rdp" ? 3389 : 22,
    environment: "development",
    group: "Tests",
    tags: [],
    favorite: false,
  };
}

describe("credentialKindFor", () => {
  it("maps SSH and RDP to distinct OS-store entries", () => {
    expect(credentialKindFor(profile("ssh"))).toBe("sshPassword");
    expect(credentialKindFor(profile("rdp"))).toBe("rdpPassword");
  });

  it("maps saved Lattice devices to their own secure pairing-code entry", () => {
    expect(credentialKindFor(profile("lattice"))).toBe("latticePairingCode");
    expect(credentialKindFor(profile("sftp"))).toBe("sftpPassword");
    expect(credentialKindFor(profile("vnc"))).toBe("vncPassword");
  });
});

describe("saved host credential probe", () => {
  it("checks cleanup and the marker-selected backend before current backend readiness", async () => {
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_host_pairing_code_cleanup_pending") return true;
      if (command === "credential_exists") return true;
      if (command === "credential_status") {
        return {
          ready: false,
          provider: "Encrypted vault",
          detail: "the preferred system keyring is locked",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const mounted = await mountCredential("latticeHostPairingCode");
    try {
      expect(mounted.state()).toEqual({
        mode: "saved",
        provider: "Encrypted vault",
        detail: null,
        cleanupPending: true,
      });
      expect(backend.invoke.mock.calls.map(([command]) => command)).toEqual([
        "remote_host_pairing_code_cleanup_pending",
        "credential_exists",
        "credential_status",
      ]);
      expect(backend.invoke).toHaveBeenCalledWith("credential_exists", {
        profileId: "remote-host",
        kind: "latticeHostPairingCode",
      });
    } finally {
      await act(async () => { mounted.root.unmount(); });
    }
  });

  it("keeps the ordinary credential readiness-before-existence order", async () => {
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "credential_status") {
        return { ready: true, provider: "Secret Service", detail: null };
      }
      if (command === "credential_exists") return true;
      throw new Error(`unexpected command: ${command}`);
    });

    const mounted = await mountCredential("sshPassword");
    try {
      expect(mounted.state()).toMatchObject({
        mode: "saved",
        provider: "Secret Service",
      });
      expect(backend.invoke.mock.calls.map(([command]) => command)).toEqual([
        "credential_status",
        "credential_exists",
      ]);
    } finally {
      await act(async () => { mounted.root.unmount(); });
    }
  });
});
