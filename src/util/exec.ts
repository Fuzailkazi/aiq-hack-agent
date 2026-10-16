/** Run an external tool (ffmpeg, soffice, pdftoppm, ...) without a shell. Never throws. */
import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The binary is not installed. */
  missing: boolean;
  timedOut: boolean;
}

export function run(cmd: string, args: string[], timeoutMs = 300_000, cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, cwd }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        missing: err?.code === "ENOENT",
        timedOut: Boolean(err?.killed),
      });
    });
  });
}
