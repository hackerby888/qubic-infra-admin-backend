export const lastCheckinMap: Record<string, number> = {};

// Convert server string (eg. "127.0.0.1@root 128.0.0.1@root" to ["127.0.0.1", "128.0.0.1"])
export function convertServersListStringToArray(serversString: string) {
    let servers = serversString.split(" ");

    for (let i = 0; i < servers.length; i++) {
        if (!servers[i]) continue;

        servers[i] = servers[i]!.trim().split("@")[1] as string;
    }

    return servers;
}

export function convertServerArrayToServersListString(
    serversArray: string[],
    username = "root"
) {
    let serversString = "";

    for (let i = 0; i < serversArray.length; i++) {
        if (!serversArray[i]) continue;

        serversString += `${serversArray[i]}@${username} `;
    }

    return serversString.trim();
}

export function getBasenameFromUrl(url: string) {
    return url.substring(url.lastIndexOf("/") + 1);
}

// Supported formats: .zip, .tar.gz, .tgz, .tar.bz2, .tbz2, .tar.xz, .txz
export function getUnzipCommandFromUrl(url: string) {
    const filename = getBasenameFromUrl(url);

    if (filename.endsWith(".zip")) {
        return `unzip ${filename}`;
    }

    if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) {
        return `tar -xvzf ${filename}`;
    }

    if (filename.endsWith(".tar.bz2") || filename.endsWith(".tbz2")) {
        return `tar -xvjf ${filename}`;
    }

    if (filename.endsWith(".tar.xz") || filename.endsWith(".txz")) {
        return `tar -xvJf ${filename}`;
    }

    return "";
}

export async function checkLink(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { method: "HEAD" });
        if (res.ok) {
            return true;
        } else {
            return false;
        }
    } catch (err) {
        return false;
    }
}

export function inlineBashCommands(commands: string[]): string {
    return commands
        .filter((cmd: string) => cmd && !cmd.trim().startsWith("#"))
        .join(" && ");
}

export function isNodeActive(lastTickChanged: number): boolean {
    // Consider a node active if its tick has changed in the last 2 minutes
    return Date.now() - lastTickChanged < 2 * 60 * 1000;
}

export function mongodbOperatorSelection(operator: string) {
    if (operator === "admin") {
        return { $exists: true };
    } else {
        return operator;
    }
}
