/** Build throwaway git repos with controlled committer dates for tests. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join } from "node:path";

const BASE_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};

export function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, ...BASE_ENV, ...env } });
}

export function writeFiles(root: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

/** Create a repo; each commit writes the given files at the given (author and committer) date. */
export function makeGitRepo(root: string, commits: [Record<string, string>, string][]): string {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  for (const [files, when] of commits) {
    writeFiles(root, files);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", `commit ${when}`], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  }
  return root;
}
