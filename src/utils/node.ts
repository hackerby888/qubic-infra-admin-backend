import crypto from "crypto";

export function calcGroupIdFromIds(ids: string[]): string {
    // No group id for default ids (0 or 676 ids)
    if (ids.length === 0 || ids.length === 676) return "";
    ids.sort();
    // Hash using sha256
    const hash = crypto.createHash("sha256");
    hash.update(ids.join(","));
    return hash.digest("hex");
}
