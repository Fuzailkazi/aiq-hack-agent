/** Generate small test videos with ffmpeg's lavfi sources (test pattern + tone). */
import { execFileSync } from "node:child_process";

export const hasFfmpeg = (): boolean => {
  try {
    execFileSync("which", ["ffmpeg"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export function makeVideo(path: string, seconds = 12, audio = true): string {
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${seconds}:size=320x240:rate=10`,
  ];
  if (audio)
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac", "-shortest");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", path);
  execFileSync("ffmpeg", args, { stdio: "ignore", timeout: 120_000 });
  return path;
}
