/** Upload the deck/video when a link was private or broken; the submission is requeued for scoring. */
import { Banner, Button, FormField } from "@shared/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, asForm, unwrap } from "../../api/client";
import { fileClass } from "../../shared/fields";
import { STATUS } from "../../shared/status";
import { recall } from "../../shared/storage";

export function AttachForm({ id }: { id: string }) {
  const [deck, setDeck] = useState<File | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const queryClient = useQueryClient();
  const attach = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      if (deck) form.append("deck", deck);
      if (video) form.append("video", video);
      form.append("reviewer", recall("hackeval.reviewer") || "organizer");
      return unwrap(
        await api.POST("/api/submissions/{id}/attach", {
          params: { path: { id } },
          body: form as never,
          ...asForm,
        }),
      );
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    attach.mutate();
  };
  return (
    <form className="flex flex-col gap-4.5" onSubmit={onSubmit} aria-label="attach files">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Deck (PDF or PPTX)" htmlFor="attach-deck">
          <input
            id="attach-deck"
            type="file"
            accept=".pdf,.pptx"
            className={fileClass}
            onChange={(e) => setDeck(e.target.files?.[0] ?? null)}
          />
        </FormField>
        <FormField label="Video" htmlFor="attach-video">
          <input
            id="attach-video"
            type="file"
            accept="video/*"
            className={fileClass}
            onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
          />
        </FormField>
      </div>
      {attach.isError && <Banner tone="bad">{attach.error.message}</Banner>}
      {attach.isSuccess && (
        <Banner tone="good">
          {STATUS[attach.data.from].label} → {STATUS[attach.data.to].label}
        </Banner>
      )}
      <div>
        <Button type="submit" variant="secondary" loading={attach.isPending} disabled={!deck && !video}>
          Attach and requeue
        </Button>
      </div>
    </form>
  );
}
