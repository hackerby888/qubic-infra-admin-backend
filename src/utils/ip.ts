import { isIPv4 } from "net";
import { logger } from "./logger.js";

export interface IpInfo {
    country: string;
    region: string;
    city: string;
    isp: string;
    lat: number;
    lon: number;
}

export async function lookupIp(ip: string): Promise<IpInfo> {
    if (!isIPv4(ip)) {
        logger.warn(`Invalid IP address: ${ip}`);
        return {
            country: "Unknown",
            region: "Unknown",
            city: "Unknown",
            isp: "Unknown",
            lat: 0,
            lon: 0,
        };
    }
    let url = `http://ip-api.com/json/${ip}`;
    let retries = 3;
    while (retries > 0) {
        try {
            let response = await fetch(url);
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch IP info: ${response.statusText}`
                );
            }
            let data = await response.json();
            if (!data.country) {
                throw new Error("Invalid data received from IP API");
            }
            return {
                country: data.country,
                region: data.regionName,
                city: data.city,
                isp: data.isp,
                lat: data.lat,
                lon: data.lon,
            };
        } catch (error) {
            logger.error(
                `Error fetching IP info: ${error}. Retries left: ${retries - 1}`
            );
            retries--;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    return {
        country: "Unknown",
        region: "Unknown",
        city: "Unknown",
        isp: "Unknown",
        lat: 0,
        lon: 0,
    };
}
