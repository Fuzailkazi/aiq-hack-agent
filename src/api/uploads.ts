/** Multipart uploads are streamed into workspace/uploads/<uuid>/, size-capped; the client never names a server path. */
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import { InputError } from "../store/queries";

export interface ParsedForm {
  fields: Record<string, string>;
  files: Record<string, string>;
}

/** Only short alphanumeric extensions from the client's filename survive (".pdf", ".pptx", ".mp4"). */
const safeExt = (filename: string): string => {
  const ext = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : "";
};

/** Byte limit per file field; a field over its limit fails the whole form. */
export type FileLimits = Record<string, number>;

/** Passes bytes through, failing once more than `max` have gone by (so a big upload stops streaming early). */
function capped(max: number, field: string): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      if (total > max)
        done(new InputError(`${field}: file is larger than the ${Math.floor(max / 1_000_000)} MB limit`));
      else done(null, chunk);
    },
  });
}

export async function readForm(
  req: FastifyRequest,
  workspace: string,
  limits: FileLimits,
): Promise<ParsedForm> {
  const allowedFiles = Object.keys(limits);
  const fields: Record<string, string> = {};
  const files: Record<string, string> = {};
  const dir = resolve(workspace, "uploads", randomUUID());
  try {
    for await (const part of req.parts()) {
      if (part.type === "field") {
        fields[part.fieldname] = String(part.value ?? "");
        continue;
      }
      const file = part as MultipartFile;
      if (!allowedFiles.includes(file.fieldname)) {
        file.file.resume();
        throw new InputError(
          `unexpected file field '${file.fieldname}' (expected ${allowedFiles.join(", ")})`,
        );
      }
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${file.fieldname}${safeExt(file.filename)}`);
      await pipeline(file.file, capped(limits[file.fieldname], file.fieldname), createWriteStream(path));
      if (file.file.truncated)
        throw new InputError(`${file.fieldname}: file is larger than the upload limit`);
      files[file.fieldname] = path;
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { fields, files };
}
