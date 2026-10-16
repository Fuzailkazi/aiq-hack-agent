/** Clone a submission repo safely (no code execution) and pin it to the deadline. */
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SecretRedactor } from "../digest/armoriq/secrets";
import { type RepoAcquisition, RepoSnapshotSchema } from "../schemas/evidence";
import type { Submission } from "../schemas/submission";

const README_CHARS = 2000;
const README_READ_BYTES = 8192;

export interface AcquireOptions {
  workspace: string;
  deadline: string | null;
  pinToDeadline: boolean;
  timeoutS: number;
  maxMb: number;
  githubToken?: string | null;
  /** Tests/dev only: allow local paths and file:// URLs. Production clones https only. */
  allowLocal?: boolean;
}

const unreachable = (reason: string): RepoAcquisition => ({
  snapshot: null,
  path: null,
  unreachableReason: reason,
});

export async function acquireRepo(sub: Submission, opts: AcquireOptions): Promise<RepoAcquisition> {
  if (!opts.allowLocal && !sub.repoUrl.startsWith("https://"))
    return unreachable("only https repository URLs are allowed");
  const dest = join(opts.workspace, "repos", sub.id);
  await rm(dest, { recursive: true, force: true });
  await mkdir(join(opts.workspace, "repos"), { recursive: true });
  const env = gitEnv(sub.repoUrl, opts.githubToken ?? null, opts.allowLocal ?? false);
  const git = (args: string[], cwd?: string) => runGit(args, { cwd, env, timeoutS: opts.timeoutS });

  // A `/tree/<ref>` link: clone that branch or tag if the remote has it; otherwise the default branch (and say so).
  const resolvedRef = sub.repoRef ? await resolveRef(sub.repoUrl, sub.repoRef, git) : null;
  // "--" stops a URL such as "-uhelp" from being read as an option.
  const clone = await git([
    "clone",
    "--filter=blob:none",
    "--no-recurse-submodules",
    "--quiet",
    ...(resolvedRef ? ["--branch", resolvedRef] : []),
    "--",
    sub.repoUrl,
    dest,
  ]);
  if (clone.code !== 0) {
    await rm(dest, { recursive: true, force: true });
    return unreachable(cloneFailureReason(clone.code, clone.out, opts.timeoutS));
  }
  if ((await dirBytes(dest)) / 1_000_000 > opts.maxMb) {
    await rm(dest, { recursive: true, force: true });
    return unreachable(`repository exceeds the ${opts.maxMb} MB limit`);
  }

  let commitsAfter = 0;
  if (opts.deadline) {
    const count = (await git(["rev-list", "--count", `--since=${opts.deadline}`, "HEAD"], dest)).out.trim();
    commitsAfter = /^\d+$/.test(count) ? Number(count) : 0;
    if (opts.pinToDeadline && commitsAfter > 0) {
      const sha = (await git(["rev-list", "-1", `--before=${opts.deadline}`, "HEAD"], dest)).out.trim();
      if (sha) await git(["checkout", "--quiet", "--detach", sha], dest);
    }
  }

  const head = await git(["log", "-1", "--format=%H%n%cI"], dest);
  const parts = head.out.trim().split("\n");
  if (head.code !== 0 || parts.length !== 2) {
    await rm(dest, { recursive: true, force: true });
    return unreachable("repository has no commits");
  }
  const tracked = (await git(["ls-files"], dest)).out.split("\n").filter(Boolean);
  const snapshot = RepoSnapshotSchema.parse({
    url: sub.repoUrl,
    commitSha: parts[0],
    committerDate: parts[1],
    commitsAfterDeadline: commitsAfter,
    fileCount: tracked.length,
    readmeExcerpt: await readmeExcerpt(dest),
    requestedRef: sub.repoRef,
    resolvedRef,
  });
  return { snapshot, path: dest, unreachableReason: null };
}

/** The longest leading part of `ref` (split on "/") that names a branch or tag on the remote, or null. */
async function resolveRef(
  url: string,
  ref: string,
  git: (args: string[]) => Promise<{ code: number; out: string }>,
): Promise<string | null> {
  const listed = await git(["ls-remote", "--heads", "--tags", "--", url]);
  if (listed.code !== 0) return null;
  const names = new Set(
    listed.out
      .split("\n")
      .map((line) => line.split("\t")[1] ?? "")
      .map((r) => r.replace(/^refs\/(heads|tags)\//, "").replace(/\^\{\}$/, "")),
  );
  const segments = ref.split("/");
  for (let n = segments.length; n > 0; n--) {
    const candidate = segments.slice(0, n).join("/");
    if (names.has(candidate)) return candidate;
  }
  return null;
}

function gitEnv(repoUrl: string, githubToken: string | null, allowLocal: boolean): NodeJS.ProcessEnv {
  // Only https (plus local files in tests): blocks ext::, ssh, git:// and file:// transports.
  const config: [string, string][] = [
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
  ];
  if (allowLocal) config.push(["protocol.file.allow", "always"]);
  if (githubToken && repoUrl.toLowerCase().startsWith("https://github.com/")) {
    // Passed via env, not argv, so the token never shows up in process listings or error text.
    const basic = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
    config.push(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

function runGit(
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutS: number },
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as { killed?: boolean }).killed) resolve({ code: 124, out: "timed out" });
        else resolve({ code: error ? Number(error.code ?? 1) || 1 : 0, out: `${stdout}${stderr}` });
      },
    );
  });
}

function cloneFailureReason(code: number, output: string, timeoutS: number): string {
  if (code === 124) return `clone timed out after ${timeoutS}s`;
  const text = output.toLowerCase();
  if (
    ["not found", "does not exist", "could not read username", "authentication failed"].some((s) =>
      text.includes(s),
    )
  ) {
    return "repository not found or private";
  }
  const last = output.trim().split("\n").at(-1);
  return (last || `git exited with ${code}`).slice(0, 300);
}

async function dirBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += (await lstat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

/** First README characters: never follows symlinks, reads a bounded prefix, and redacts secrets. */
async function readmeExcerpt(root: string): Promise<string> {
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.toLowerCase().startsWith("readme")) continue; // symlinks are not isFile()
    const handle = await open(join(root, entry.name), "r");
    try {
      const buffer = Buffer.alloc(README_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, README_READ_BYTES, 0);
      return new SecretRedactor()
        .redact(buffer.subarray(0, bytesRead).toString("utf8"))
        .slice(0, README_CHARS);
    } finally {
      await handle.close();
    }
  }
  return "";
}
