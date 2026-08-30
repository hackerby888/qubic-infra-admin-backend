import { execSync } from "child_process";
import os from "os";

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

// The address this box is reached on, so System Health can name an instance by IP
// instead of a UUID. Set INSTANCE_IP when the public IP isn't on a local interface.
function firstExternalIpv4(): string | null {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === "IPv4" && !address.internal) {
                return address.address;
            }
        }
    }

    return null;
}

const ip = process.env.INSTANCE_IP || firstExternalIpv4() || "unknown";

export const BuildInfo = {
    commit,
    startedAt,
    ip,
};
