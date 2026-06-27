import { execSync } from "child_process";

// Build/version info captured ONCE at process start. Surfaced via /health and
// the System Health page so you can confirm a deploy actually landed: after a
// rolling deploy each instance restarts, so its `commit` flips to the new SHA
// and `startedAt` resets. Reads the checked-out commit from the repo (the PM2
// deploy does git reset --hard → build → pm2 restart, so HEAD == the running
// build). Falls back to BUILD_COMMIT env, then "unknown".
const startedAt = new Date();

let commit = process.env.BUILD_COMMIT || "unknown";
try {
    commit = execSync("git rev-parse --short HEAD", {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
} catch {
    // no git / detached environment — keep the env fallback or "unknown"
}

export const BuildInfo = {
    commit,
    startedAt,
};
