import { PageState } from "@shared/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { api, setUnauthorizedHandler } from "./api/client";
import { Login } from "./features/auth/Login";
import { AppShell, SignOutContext } from "./shell/AppShell";

// One chunk per screen: the first load only carries the shell and the screen you open.
const HackathonList = lazy(() =>
  import("./features/hackathons/HackathonList").then((m) => ({ default: m.HackathonList })),
);
const Dashboard = lazy(() =>
  import("./features/hackathons/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const Import = lazy(() => import("./features/intake/Import").then((m) => ({ default: m.Import })));
const Submissions = lazy(() =>
  import("./features/submissions/Submissions").then((m) => ({ default: m.Submissions })),
);
const SubmissionDetail = lazy(() =>
  import("./features/submissions/SubmissionDetail").then((m) => ({ default: m.SubmissionDetail })),
);
const ReviewQueue = lazy(() =>
  import("./features/review/ReviewQueue").then((m) => ({ default: m.ReviewQueue })),
);
const Leaderboard = lazy(() =>
  import("./features/leaderboard/Leaderboard").then((m) => ({ default: m.Leaderboard })),
);

function Routed() {
  return (
    <Suspense fallback={<PageState state="loading" headline="Loading" />}>
      <Routes>
        <Route path="/" element={<HackathonList />} />
        <Route path="/h/:hid" element={<Dashboard />} />
        <Route path="/h/:hid/import" element={<Import />} />
        <Route path="/h/:hid/submissions" element={<Submissions />} />
        <Route path="/h/:hid/review" element={<ReviewQueue />} />
        <Route path="/h/:hid/leaderboard" element={<Leaderboard />} />
        <Route path="/s/:id" element={<SubmissionDetail />} />
        <Route
          path="*"
          element={
            <AppShell crumbs={[{ label: "Hackathons", to: "/" }, { label: "Not found" }]}>
              <PageState state="empty" headline="Page not found" />
            </AppShell>
          }
        />
      </Routes>
    </Suspense>
  );
}

export function App({ queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }) }) {
  const [authed, setAuthed] = useState(true);
  useEffect(() => setUnauthorizedHandler(() => setAuthed(false)), []);
  const login = () => {
    queryClient.clear();
    setAuthed(true);
  };
  const logout = async () => {
    await api.DELETE("/api/session");
    queryClient.clear();
    setAuthed(false);
  };
  return (
    <QueryClientProvider client={queryClient}>
      <SignOutContext.Provider value={() => void logout()}>
        <BrowserRouter>{authed ? <Routed /> : <Login onLogin={login} />}</BrowserRouter>
      </SignOutContext.Provider>
    </QueryClientProvider>
  );
}
