import { useEffect, useRef, useState } from "react";
import type { ConnectionProfile } from "../domain/connection";
import { hasDesktopBackend } from "./nativeRuntime";
import { readConnectionCredential, readConnectionCredentialStatus, supportsCredentialRecord, type ConnectionCredentialDraft } from "./connectionCredentialRecord";

export function useConnectionCredentialDraft(profile: ConnectionProfile | null) {
  const native = hasDesktopBackend();
  const [secret, setSecretValue] = useState("");
  const [secretChanged, setSecretChanged] = useState(false);
  const [allowMcpRead, setAllowMcpReadValue] = useState(false);
  const [initialAllow, setInitialAllow] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(Boolean(native && profile && supportsCredentialRecord(profile)));
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const secretRevision = useRef(0);
  const permissionRevision = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const permission = permissionRevision.current;
    if (!native || !profile || !supportsCredentialRecord(profile)) return;
    setLoading(true);
    void readConnectionCredentialStatus(profile.id).then(status => {
      if (generation.current !== current) return;
      setSaved(status.saved);
      setError(status.detail ?? null);
      if (permissionRevision.current === permission) setAllowMcpReadValue(status.allowMcpRead);
      setInitialAllow(status.allowMcpRead);
    }).catch(reason => {
      if (generation.current === current) setError(String(reason));
    }).finally(() => {
      if (generation.current === current) setLoading(false);
    });
    return () => { generation.current += 1; };
  }, [native, profile?.id]);

  function setSecret(value: string) {
    secretRevision.current += 1;
    setSecretValue(value);
    setSecretChanged(value.length > 0);
  }

  function setAllowMcpRead(value: boolean) {
    permissionRevision.current += 1;
    setAllowMcpReadValue(value);
  }

  function invalidateReveal() {
    secretRevision.current += 1;
  }

  async function reveal() {
    if (!profile || revealing || secretChanged) return false;
    const current = generation.current;
    const revision = secretRevision.current;
    setRevealing(true);
    setError(null);
    try {
      const value = await readConnectionCredential(profile.id);
      if (generation.current !== current || secretRevision.current !== revision) return false;
      setSecretValue(value);
      return true;
    } catch (reason) {
      if (generation.current === current && secretRevision.current === revision) setError(String(reason));
      return false;
    } finally {
      if (generation.current === current) setRevealing(false);
    }
  }

  const dirty = (secretChanged && secret.length > 0) || allowMcpRead !== initialAllow;
  const credential: ConnectionCredentialDraft | undefined = dirty
    ? { secret: secretChanged && secret.length > 0 ? secret : null, allowMcpRead }
    : undefined;

  return { native, secret, setSecret, allowMcpRead, setAllowMcpRead, saved, loading, revealing, error, reveal, invalidateReveal, dirty, credential };
}
