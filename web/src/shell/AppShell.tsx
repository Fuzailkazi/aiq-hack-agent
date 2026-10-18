/**
 * The application frame, after ArmorIQ's DashboardShell: a left rail (brand, hackathon sections, theme, sign-out),
 * a top bar carrying the breadcrumb, and the routed content. Below lg the rail collapses into a tab strip.
 */
import { IconChart, IconEye, IconGauge, IconRows, IconUpload } from "@shared/icons";
import { Breadcrumb, Button, SegmentedControl, TabRail, Tabs } from "@shared/ui";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { Brand } from "./Brand";
import { type Theme, useTheme } from "./theme";

export type Section = "dashboard" | "import" | "submissions" | "review" | "leaderboard";
export interface Crumb {
  label: string;
  to?: string;
}

const SECTIONS = [
  { key: "dashboard", label: "Dashboard", icon: IconGauge, path: "" },
  { key: "import", label: "Import", icon: IconUpload, path: "/import" },
  { key: "submissions", label: "Submissions", icon: IconRows, path: "/submissions" },
  { key: "review", label: "Review queue", icon: IconEye, path: "/review" },
  { key: "leaderboard", label: "Leaderboard", icon: IconChart, path: "/leaderboard" },
] as const;

/** Sign-out lives in the shell; the App provides it. */
export const SignOutContext = createContext<() => void>(() => {});

export function AppShell({
  crumbs,
  hid,
  section,
  children,
}: {
  crumbs: Crumb[];
  /** The hackathon whose sections the rail shows (none on the hackathon list). */
  hid?: string;
  section?: Section;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const signOut = useContext(SignOutContext);
  const [theme, setTheme] = useTheme();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => (await api.GET("/api/session")).data ?? null,
    staleTime: 300_000,
  });
  const email = session.data?.email;
  const go = (key: string) => {
    const s = SECTIONS.find((x) => x.key === key);
    if (s && hid) navigate(`/h/${hid}${s.path}`);
  };
  const items = SECTIONS.map(({ key, label, icon }) => ({ key, label, icon }));

  return (
    <div className="bg-aq-bg flex min-h-full">
      <aside className="bg-aq-surface border-aq-border hidden w-60 shrink-0 flex-col border-r lg:flex">
        <div className="border-aq-border flex h-14 items-center border-b px-4.5">
          <button type="button" onClick={() => navigate("/")} aria-label="All hackathons">
            <Brand />
          </button>
        </div>
        <div className="flex-1 p-3">
          {hid && section && (
            <TabRail ariaLabel="Hackathon sections" value={section} onChange={go} items={items} />
          )}
        </div>
        <div className="border-aq-border flex flex-col gap-3 border-t p-3">
          <SegmentedControl
            ariaLabel="Theme"
            value={theme}
            onChange={(v) => setTheme(v as Theme)}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
          {email && (
            <span className="text-aq-xs text-aq-ink-muted truncate text-center" title={email}>
              Signed in as {email}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-aq-surface border-aq-border sticky top-0 z-30 flex h-14 items-center gap-4 border-b px-5">
          <span className="lg:hidden">
            <Brand />
          </span>
          <Breadcrumb
            items={crumbs.map((c, i) => ({
              key: `${i}-${c.label}`,
              label: c.label,
              active: i === crumbs.length - 1,
              onClick: c.to ? () => navigate(c.to ?? "/") : undefined,
            }))}
          />
          <span className="flex-1" />
          <span className="lg:hidden">
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </span>
        </header>
        {hid && section && (
          <div className="bg-aq-surface border-aq-border border-b px-5 lg:hidden">
            <Tabs ariaLabel="Hackathon sections (compact)" value={section} onChange={go} items={items} />
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl px-6 py-6.5">{children}</main>
      </div>
    </div>
  );
}
