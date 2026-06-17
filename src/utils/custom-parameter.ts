import { Mongodb } from "../database/db.js";

// Fleet-wide global lite-node custom parameter. Stored as a single settings
// document; merged with each node's per-machine parameter at apply time
// (deploy / restart / file write) instead of overwriting it.
const GLOBAL_LITE_PARAM_KEY = "liteNodeGlobalCustomParameter";

export async function getGlobalLiteCustomParameter(): Promise<string> {
    try {
        let doc = await Mongodb.getSettingsCollection().findOne({
            key: GLOBAL_LITE_PARAM_KEY,
        });
        return doc?.value || "";
    } catch {
        return "";
    }
}

export async function setGlobalLiteCustomParameter(
    value: string
): Promise<void> {
    await Mongodb.getSettingsCollection().updateOne(
        { key: GLOBAL_LITE_PARAM_KEY },
        { $set: { value } },
        { upsert: true }
    );
}

// Merge the global and per-machine custom parameters into the final CLI arg
// string. The machine value is placed last so it wins on duplicate flags
// (CLI args are last-wins). Empty parts are dropped.
export function mergeCustomParameter(
    globalParam: string,
    machineParam: string
): string {
    return [globalParam, machineParam]
        .map((s) => (s || "").trim())
        .filter((s) => s.length > 0)
        .join(" ");
}
