import { Banner, Button, FormField } from "@shared/ui";
import { type FormEvent, useState } from "react";
import { api } from "../../api/client";
import { inputClass } from "../../shared/fields";
import { AuthLayout } from "../../shell/AuthLayout";

/** Exchanges the admin token for an HttpOnly session cookie (so slide images and video load too). */
export function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { response } = await api.POST("/api/session", { body: { token } });
    setBusy(false);
    if (response.ok) onLogin();
    else setError("That token was not accepted.");
  };
  return (
    <AuthLayout>
      <h1 className="text-aq-h2 tracking-aq-tight text-aq-ink font-semibold">Sign in</h1>
      <p className="text-aq-sm text-aq-ink-muted mt-1 mb-6.5">
        Use the admin token set in HACKEVAL_ADMIN_TOKEN.
      </p>
      <form className="flex flex-col gap-4.5" onSubmit={onSubmit}>
        <FormField label="Admin token" htmlFor="token" required>
          <input
            id="token"
            type="password"
            className={inputClass}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </FormField>
        {error && <Banner tone="bad">{error}</Banner>}
        <Button type="submit" variant="primary" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
