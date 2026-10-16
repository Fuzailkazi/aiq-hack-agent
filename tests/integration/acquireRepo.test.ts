import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRepo } from "../../src/acquire/repo";
import { SubmissionSchema } from "../../src/schemas/submission";
import { git, makeGitRepo } from "../gitRepo";
import { tempDir } from "../helpers";

const SEP30 = "2026-09-30T12:00:00Z";
const OCT01 = "2026-10-01T00:00:00Z";
const OCT02 = "2026-10-02T12:00:00Z";
const sub = (url: string) =>
  SubmissionSchema.parse({ id: "sub1", hackathonId: "h", teamName: "T", repoUrl: url, submittedAt: SEP30 });
const acquire = (
  url: string,
  ws: string,
  opts: { deadline?: string | null; pin?: boolean; maxMb?: number } = {},
) =>
  acquireRepo(sub(url), {
    workspace: ws,
    deadline: opts.deadline ?? null,
    pinToDeadline: opts.pin ?? true,
    timeoutS: 60,
    maxMb: opts.maxMb ?? 200,
    allowLocal: true,
  });
const same = (a: string | undefined, b: string) => Date.parse(a ?? "") === Date.parse(b);

describe("branch links", () => {
  const branchy = () => {
    const root = makeGitRepo(join(tempDir(), "repo"), [[{ "README.md": "main\n" }, SEP30]]);
    for (const branch of ["hackathon", "feature/x"]) {
      git(root, ["checkout", "-q", "-b", branch, "main"]);
      writeFileSync(join(root, "branch.txt"), `${branch}\n`);
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", branch], { GIT_AUTHOR_DATE: SEP30, GIT_COMMITTER_DATE: SEP30 });
    }
    git(root, ["checkout", "-q", "main"]);
    return root;
  };
  const withRef = (url: string, repoRef: string) =>
    acquireRepo(
      { ...sub(url), repoRef },
      {
        workspace: tempDir(),
        deadline: null,
        pinToDeadline: true,
        timeoutS: 60,
        maxMb: 200,
        allowLocal: true,
      },
    );

  it("clones the branch the team linked, including branch names with slashes and trailing paths", async () => {
    const root = branchy();
    const plain = await withRef(root, "hackathon");
    expect(plain.snapshot?.resolvedRef).toBe("hackathon");
    expect(readFileSync(join(plain.path ?? "", "branch.txt"), "utf8")).toBe("hackathon\n");
    const nested = await withRef(root, "feature/x/src/app");
    expect(nested.snapshot?.resolvedRef).toBe("feature/x");
    expect(readFileSync(join(nested.path ?? "", "branch.txt"), "utf8")).toBe("feature/x\n");
  });

  it("falls back to the default branch when the link names no branch or tag, and says so", async () => {
    const result = await withRef(branchy(), "nope/src");
    expect(result.snapshot?.requestedRef).toBe("nope/src");
    expect(result.snapshot?.resolvedRef).toBeNull();
    expect(existsSync(join(result.path ?? "", "branch.txt"))).toBe(false);
  });
});

describe("acquireRepo", () => {
  it("clones and snapshots", async () => {
    const dir = tempDir();
    const origin = makeGitRepo(join(dir, "origin"), [
      [{ "README.md": "# Alpha\nGuarded agent", "a.py": "x = 1" }, SEP30],
    ]);
    const acq = await acquire(origin, join(dir, "ws"));
    expect(acq.unreachableReason).toBeNull();
    expect(acq.snapshot?.commitSha).toHaveLength(40);
    expect(same(acq.snapshot?.committerDate, SEP30)).toBe(true);
    expect(acq.snapshot?.fileCount).toBe(2);
    expect(acq.snapshot?.readmeExcerpt.startsWith("# Alpha")).toBe(true);
    expect(acq.snapshot?.commitsAfterDeadline).toBe(0);
  });

  it("reports a missing repo as unreachable", async () => {
    const dir = tempDir();
    const acq = await acquire(join(dir, "nope"), join(dir, "ws"));
    expect(acq.snapshot).toBeNull();
    expect(acq.unreachableReason).toBe("repository not found or private");
  });

  it("pins to the last commit before the deadline", async () => {
    const dir = tempDir();
    const origin = makeGitRepo(join(dir, "origin"), [
      [{ "a.py": "v1" }, SEP30],
      [{ "late.py": "v2" }, OCT02],
    ]);
    const acq = await acquire(origin, join(dir, "ws"), { deadline: OCT01 });
    expect(same(acq.snapshot?.committerDate, SEP30)).toBe(true);
    expect(acq.snapshot?.commitsAfterDeadline).toBe(1);
    expect(existsSync(join(dir, "ws/repos/sub1/late.py"))).toBe(false);
  });

  it("keeps HEAD when pinning is off, but counts late commits", async () => {
    const dir = tempDir();
    const origin = makeGitRepo(join(dir, "origin"), [
      [{ "a.py": "v1" }, SEP30],
      [{ "late.py": "v2" }, OCT02],
    ]);
    const acq = await acquire(origin, join(dir, "ws"), { deadline: OCT01, pin: false });
    expect(same(acq.snapshot?.committerDate, OCT02)).toBe(true);
    expect(acq.snapshot?.commitsAfterDeadline).toBe(1);
  });

  it("keeps HEAD when every commit is after the deadline", async () => {
    const dir = tempDir();
    const origin = makeGitRepo(join(dir, "origin"), [[{ "a.py": "v1" }, OCT02]]);
    const acq = await acquire(origin, join(dir, "ws"), { deadline: OCT01 });
    expect(same(acq.snapshot?.committerDate, OCT02)).toBe(true);
    expect(acq.snapshot?.commitsAfterDeadline).toBe(1);
  });

  it("enforces the size cap and cleans up", async () => {
    const dir = tempDir();
    const origin = makeGitRepo(join(dir, "origin"), [[{ "a.py": "x".repeat(2000) }, SEP30]]);
    const acq = await acquire(origin, join(dir, "ws"), { maxMb: 0 });
    expect(acq.unreachableReason).toBe("repository exceeds the 0 MB limit");
    expect(existsSync(join(dir, "ws/repos/sub1"))).toBe(false);
  });

  it("re-acquiring replaces the previous checkout", async () => {
    const dir = tempDir();
    const origin = makeGitRepo(join(dir, "origin"), [[{ "a.py": "v1" }, SEP30]]);
    await acquire(origin, join(dir, "ws"));
    expect((await acquire(origin, join(dir, "ws"))).snapshot).not.toBeNull();
  });

  it("never follows a README symlink and redacts README secrets", async () => {
    const dir = tempDir();
    const secret = join(dir, "organizer.env");
    writeFileSync(secret, "TYPESAFE_API_KEY=organizer-secret\n");
    const origin = makeGitRepo(join(dir, "origin"), [[{ "a.py": "x" }, SEP30]]);
    symlinkSync(secret, join(origin, "README.md"));
    git(origin, ["add", "-A"]);
    git(origin, ["commit", "-qm", "link"], { GIT_AUTHOR_DATE: SEP30, GIT_COMMITTER_DATE: SEP30 });
    expect((await acquire(origin, join(dir, "ws"))).snapshot?.readmeExcerpt).not.toContain(
      "organizer-secret",
    );
    const keyed = makeGitRepo(join(dir, "keyed"), [
      [{ "README.md": "Key: ak_live_9f8e7d6c5b4a3210ffee" }, SEP30],
    ]);
    const excerpt = (await acquire(keyed, join(dir, "ws2"))).snapshot?.readmeExcerpt ?? "";
    expect(excerpt).not.toContain("ak_live_9f8e7d6c5b4a3210ffee");
    expect(excerpt).toContain("ak_****ffee");
  });

  it.each(["-uhelp", "ext::sh -c touch% /tmp/pwned", "file:///etc", "git@github.com:o/r.git"])(
    "refuses non-https URL %s in production",
    async (url) => {
      const dir = tempDir();
      const acq = await acquireRepo(sub(url), {
        workspace: join(dir, "ws"),
        deadline: null,
        pinToDeadline: true,
        timeoutS: 30,
        maxMb: 10,
      });
      expect(acq.snapshot).toBeNull();
      expect(acq.unreachableReason).toBe("only https repository URLs are allowed");
    },
  );

  it("treats an empty repository as unreachable", async () => {
    const dir = tempDir();
    const origin = join(dir, "empty");
    mkdirSync(origin);
    git(origin, ["init", "-q", "-b", "main"]);
    const acq = await acquire(origin, join(dir, "ws"), { deadline: OCT01 });
    expect(acq.snapshot).toBeNull();
    expect(acq.unreachableReason).toBe("repository has no commits");
  });
});
