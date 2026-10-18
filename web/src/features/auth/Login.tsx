import { Banner, Button } from "@shared/ui";
import { useEffect, useState } from "react";
import { AuthLayout } from "../../shell/AuthLayout";

/**
 * Sign in with Google. The server sends the person to Google, checks the verified email against its allowlist, and
 * sets an HttpOnly session cookie; a rejected account comes back here with ?signin_error=.
 */
export function Login() {
  const [error] = useState(() => new URLSearchParams(globalThis.location?.search ?? "").get("signin_error"));
  const [contact, setContact] = useState<string | null>(null);
  useEffect(() => {
    if (error) globalThis.history?.replaceState({}, "", globalThis.location.pathname);
    fetch(`${globalThis.location.origin}/api/auth/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: { contact?: string | null } | null) => setContact(c?.contact ?? null))
      .catch(() => {});
  }, [error]);
  return (
    <AuthLayout>
      <h1 className="text-aq-h2 tracking-aq-tight text-aq-ink font-semibold">Sign in</h1>
      <p className="text-aq-sm text-aq-ink-muted mt-1 mb-6.5">
        Use your ArmorIQ Google account. Only invited judges can open this workspace.
      </p>
      <div className="flex flex-col gap-4.5">
        {error && (
          <Banner tone="bad">
            {error}
            {contact ? `. Ask ${contact} for access.` : ""}
          </Banner>
        )}
        <Button variant="primary" onClick={() => globalThis.location.assign("/api/auth/google")}>
          Sign in with Google
        </Button>
      </div>
    </AuthLayout>
  );
}
