import { Mongodb, MongoDbTypes } from "../database/db.js";
import { logger } from "./logger.js";

/**
 * Persist one alert/incident row for the System Events admin view.
 *
 * Fire-and-forget: callers sit inside watcher loops that must not stall or die on a Mongo
 * hiccup, so failures are logged and swallowed. Callers log only on a state TRANSITION,
 * never on a repeat/cooldown alert, otherwise one outage writes a row per cooldown window.
 *
 * Returns the promise so a caller about to exit the process can let the write flush.
 */
export function logSystemEvent(event: Omit<MongoDbTypes.SystemEvent, "createdAt" | "timestamp">): Promise<unknown> {
    const now = new Date();

    return Mongodb.getSystemEventsCollection()
        .insertOne({ ...event, createdAt: now, timestamp: now.getTime() }, { writeConcern: { w: 1 } })
        .catch((error) => logger.error(`Failed to log system event (${event.type}): ${(error as Error).message}`));
}
