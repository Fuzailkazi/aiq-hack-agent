/** Intake (CSV import, single upload), submission detail, judge decisions and file attachment. */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { addSubmission, importCsv } from "../../intake";
import { judgeAverage, saveJudgeScore } from "../../judgeScore";
import { JudgeScoreSchema, StatusSchema } from "../../schemas/evaluation";
import { attachFiles, checklist, decide, statusReasons } from "../../service";
import { intakeOf } from "../../settings";
import * as q from "../../store/queries";
import { type ApiContext, nowIso } from "../context";
import {
  AddOutcomeSchema,
  DecisionSchema,
  HidParams,
  IdParams,
  ImportReportSchema,
  JudgeScoreBodySchema,
  SubmissionDetailSchema,
  SubmissionRowSchema,
  TransitionSchema,
} from "../schemas";
import { readForm } from "../uploads";

const HTTP_URL = /^https?:\/\/\S+$/i;
const CSV_MAX_BYTES = 20_000_000;

/** A link typed by the client must be an http(s) URL: server-side paths are never accepted over HTTP. */
function linkField(kind: string, value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (!HTTP_URL.test(v)) throw new q.InputError(`${kind}Url must be an http(s) link (or upload the file)`);
  return v;
}

export const submissionRoutes =
  ({ db, settings, limits }: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const media = { deck: limits.deckMaxBytes, video: limits.videoMaxBytes };
    app.post(
      "/api/hackathons/:hid/import",
      {
        schema: {
          params: HidParams,
          consumes: ["multipart/form-data"],
          response: { 200: ImportReportSchema },
        },
      },
      async (req) => {
        const hid = q.getHackathon(db, req.params.hid).id;
        const { files } = await readForm(req, settings.workspace, { file: CSV_MAX_BYTES });
        if (!files.file) throw new q.InputError("attach the CSV as the 'file' field");
        return importCsv(db, hid, files.file, intakeOf(settings), nowIso());
      },
    );

    app.post(
      "/api/hackathons/:hid/submissions",
      {
        schema: { params: HidParams, consumes: ["multipart/form-data"], response: { 200: AddOutcomeSchema } },
      },
      async (req) => {
        const hid = q.getHackathon(db, req.params.hid).id;
        const { fields, files } = await readForm(req, settings.workspace, media);
        if (!fields.teamName?.trim() || !fields.repoUrl?.trim())
          throw new q.InputError("teamName and repoUrl are required");
        const outcome = addSubmission(
          db,
          hid,
          {
            teamName: fields.teamName.trim(),
            repoUrl: fields.repoUrl.trim(),
            deck: files.deck ?? linkField("deck", fields.deckUrl),
            video: files.video ?? linkField("video", fields.videoUrl),
            track: fields.track?.trim() || null,
            externalId: fields.externalId?.trim() || null,
          },
          nowIso(),
        );
        return { outcome };
      },
    );

    app.get(
      "/api/hackathons/:hid/submissions",
      {
        schema: {
          params: HidParams,
          querystring: z.object({ status: StatusSchema.optional() }),
          response: { 200: z.array(SubmissionRowSchema) },
        },
      },
      async (req) => {
        const hid = q.getHackathon(db, req.params.hid).id;
        return q
          .currentSubmissions(db, hid, req.query.status ? [req.query.status] : undefined)
          .map(({ submission, status }) => {
            const ev = q.getEvaluation(db, submission.id);
            return {
              id: submission.id,
              teamName: submission.teamName,
              projectName: submission.answers.projectName ?? null,
              repoUrl: submission.repoUrl,
              track: submission.track,
              status,
              reasons: statusReasons(status, ev),
              checks: checklist(submission, ev),
              autoScore: ev?.autoScore ?? null,
              finalScore: ev?.finalScore ?? null,
              judgeScore: judgeAverage(ev),
              confidence: ev?.calibration?.confidence ?? null,
            };
          });
      },
    );

    app.get(
      "/api/submissions/:id",
      { schema: { params: IdParams, response: { 200: SubmissionDetailSchema } } },
      async (req) => {
        const { submission, status } = q.getSubmission(db, req.params.id);
        const evaluation = q.getEvaluation(db, submission.id);
        return {
          submission,
          status,
          reasons: statusReasons(status, evaluation),
          checks: checklist(submission, evaluation),
          evaluation,
          calibration: evaluation?.calibration ?? null,
        };
      },
    );

    app.post(
      "/api/submissions/:id/decision",
      { schema: { params: IdParams, body: DecisionSchema, response: { 200: TransitionSchema } } },
      async (req) => decide(db, req.params.id, req.body, nowIso()),
    );

    app.put(
      "/api/submissions/:id/judge-score",
      { schema: { params: IdParams, body: JudgeScoreBodySchema, response: { 200: JudgeScoreSchema } } },
      async (req) => saveJudgeScore(db, req.params.id, req.body, nowIso()),
    );

    app.post(
      "/api/submissions/:id/attach",
      {
        schema: { params: IdParams, consumes: ["multipart/form-data"], response: { 200: TransitionSchema } },
      },
      async (req) => {
        q.getSubmission(db, req.params.id);
        const { fields, files } = await readForm(req, settings.workspace, media);
        if (!files.deck && !files.video) throw new q.InputError("attach a 'deck' and/or 'video' file");
        return attachFiles(db, req.params.id, files, fields.reviewer?.trim() || "organizer", nowIso());
      },
    );
  };
