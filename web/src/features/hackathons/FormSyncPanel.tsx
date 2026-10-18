/** The link to the Google Form: when it last synced, what came in, rows it could not import, and Sync now. */
import { IconLink, IconRefresh } from "@shared/icons";
import { Banner, Button } from "@shared/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../../api/client";
import { Panel } from "../../shared/Panel";

function ago(iso: string, now = Date.now()): string {
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : new Date(iso).toLocaleString();
}

export function FormSyncPanel({ hid }: { hid: string }) {
  const queryClient = useQueryClient();
  const info = useQuery({
    queryKey: ["hackathon", hid, "sync"],
    queryFn: async () => unwrap(await api.GET("/api/hackathons/{hid}/sync", { params: { path: { hid } } })),
    refetchInterval: 60_000,
  });
  const syncNow = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/hackathons/{hid}/sync", { params: { path: { hid } } })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["hackathon", hid] }),
  });
  const data = info.data;
  const last = syncNow.data ?? data?.last ?? null;

  return (
    <Panel title="Google Form sync" icon={IconLink} tone="info">
      {!data ? null : !data.configured ? (
        <p className="text-aq-sm text-aq-ink-muted">
          Not linked to the form yet. Set HACKEVAL_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE (see the runbook)
          and new entries arrive here automatically. Until then, use Import.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-aq-sm text-aq-ink-soft">
            Checks the form every {data.intervalMin} min, imports new and edited entries and runs the SDK gate
            on them
            {data.autoScore ? ", then scores them." : ". Scoring stays a button press (it spends AI quota)."}
          </p>
          {last && (
            <div className="flex flex-col gap-1.5" data-testid="sync-status">
              <span className="text-aq-sm text-aq-ink">
                {last.ok ? "Synced" : "Sync failed"} {ago(last.at)}
                {last.ok &&
                  ` · ${last.created} new · ${last.updated} updated · ${last.unchanged} unchanged${last.runId ? " · gate started" : ""}`}
              </span>
              {last.error && <Banner tone="bad">{last.error}</Banner>}
              {last.skipped.length > 0 && (
                <Banner tone="warn">
                  <span className="block font-medium">
                    {last.skipped.length} {last.skipped.length === 1 ? "entry" : "entries"} could not be
                    imported (contact the team):
                  </span>
                  <ul className="flex flex-col gap-0.5">
                    {last.skipped.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </Banner>
              )}
            </div>
          )}
          {syncNow.isError && <Banner tone="bad">{syncNow.error.message}</Banner>}
          <div>
            <Button
              variant="secondary"
              size="sm"
              leading={IconRefresh}
              loading={syncNow.isPending}
              onClick={() => syncNow.mutate()}
            >
              Sync now
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
