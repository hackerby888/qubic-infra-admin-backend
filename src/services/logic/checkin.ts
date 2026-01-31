import { Mongodb, type MongoDbTypes } from "../../database/db.js";
import { getLastWednesdayTimestamp } from "../../utils/time.js";
import { NodeService } from "../node-service.js";
import NodeCache from "node-cache";

namespace Checkin {
    let cache = new NodeCache({ stdTTL: 15 * 60, checkperiod: 20 * 60 });
    export async function getCheckins({
        type,
        operator,
        ipv4,
        normalized,
        epoch,
        excludeDefaultOp,
    }: {
        type?: string | undefined;
        operator?: string | undefined;
        ipv4?: string | undefined;
        normalized?: boolean | undefined;
        epoch: number;
        excludeDefaultOp?: boolean | undefined;
    }): Promise<any[]> {
        // check cache first
        let cacheKeyObject = {
            type,
            operator,
            ipv4,
            normalized,
            epoch,
            excludeDefaultOp,
        };
        let cacheKey = JSON.stringify(cacheKeyObject);
        let cached = cache.get<any[]>(cacheKey);
        if (cached) {
            return cached;
        }

        // no cache, fetch from db
        let query: any = {};

        if (excludeDefaultOp) {
            query.operator = {
                $ne: "BZBQFLLBNCXEMGLOBHUVFTLUPLVCPQUASSILFABOFFBCADQSSUPNWLZBQEXK",
            };
        } else if (operator) {
            query.operator = operator;
        }

        if (type) {
            query.type = type;
        }

        if (ipv4) {
            // support ipv4 partial match
            query.ip = { $regex: ipv4 };
        }

        let networkStatus = NodeService.getNetworkStatus();
        if (epoch === 0) {
            epoch = networkStatus.epoch;
        }

        if (epoch > networkStatus.epoch) {
            throw new Error(
                `Invalid epoch number, ${epoch} > ${networkStatus.epoch}`
            );
        }

        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        let lastWedTimestamp = getLastWednesdayTimestamp().timestamp;
        let nextWedTimestamp = 0;
        if (networkStatus.epoch > epoch) {
            lastWedTimestamp -= (networkStatus.epoch - epoch) * ONE_WEEK_MS;
            nextWedTimestamp = lastWedTimestamp + ONE_WEEK_MS;
        } else {
            // current time cause we are in the same epoch (not ended yet)
            nextWedTimestamp = new Date().getTime();
        }

        query.lastCheckinAt = {
            $gte: lastWedTimestamp,
            $lt: nextWedTimestamp,
        };

        let checkins = (await Mongodb.getCheckinsCollection()
            .find(query, { projection: { _id: 0 } })
            .limit(normalized ? Infinity : 1000)
            .skip(0)
            .toArray()) as MongoDbTypes.Checkin[];

        if (normalized) {
            // merge checkins by type+operator+ip, calc total uptime and last checkin
            let mergedCheckins: Record<
                string,
                MongoDbTypes.Checkin & {
                    totalUptime: number;
                    firstSeenAt: number;
                }
            > = {};
            for (let checkin of checkins.sort(
                (a, b) => a.timestamp - b.timestamp
            )) {
                let key = `${checkin.type}-${checkin.operator}-${checkin.ip}`;
                if (!mergedCheckins[key]) {
                    mergedCheckins[key] = {
                        ...checkin,
                        totalUptime: 0,
                        firstSeenAt: checkin.timestamp * 1000,
                    };
                } else {
                    // if current uptime is greater than previous uptime, add the difference to totalUptime
                    if (checkin.uptime >= mergedCheckins[key].uptime) {
                        mergedCheckins[key].totalUptime +=
                            checkin.uptime - mergedCheckins[key].uptime;
                    } else {
                        // else, just add the current uptime (node restarted)
                        mergedCheckins[key].totalUptime += checkin.uptime;
                    }
                    // update other fields
                    mergedCheckins[key].timestamp = checkin.timestamp * 1000;
                    mergedCheckins[key].uptime = checkin.uptime;
                    mergedCheckins[key].lastCheckinAt = checkin.lastCheckinAt;
                }
            }
            // delete unused fields
            const unusedFields = ["uptime"];
            for (let key in mergedCheckins) {
                for (let field of unusedFields) {
                    delete (mergedCheckins[key] as any)[field];
                }
            }
            // convert to array
            checkins = Object.values(mergedCheckins) as MongoDbTypes.Checkin[];
        }

        // reformat ip from db (if ipv6 format, convert to ipv4
        checkins = checkins.map((checkin) => {
            if (checkin.ip && checkin.ip.startsWith("::ffff:")) {
                checkin.ip = checkin.ip.replace("::ffff:", "");
            }
            return checkin;
        });

        // set cache
        cache.set(cacheKey, checkins);

        return checkins;
    }
}

export { Checkin };
