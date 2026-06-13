import { isIPv4 } from "net";
import type { Request } from "express";
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

/**
 * Normalize an IP string. Strips the IPv4-mapped IPv6 prefix
 * ("::ffff:1.2.3.4" -> "1.2.3.4"). Plain IPv4 and native IPv6 pass through
 * unchanged. Native IPv6 cannot be converted to IPv4 server-side.
 */
export function normalizeIp(ip: string | undefined | null): string {
    if (!ip) return "";
    let out = ip.trim();
    if (out.toLowerCase().startsWith("::ffff:")) {
        out = out.slice("::ffff:".length);
    }
    return out;
}

function headerFirst(
    value: string | string[] | undefined
): string | undefined {
    if (!value) return undefined;
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolve the REAL client IP from a request, accounting for reverse proxies
 * (Cloudflare / nginx / load balancers). Without this, req.ip /
 * socket.remoteAddress return the proxy's IP, not the user's.
 *
 * Priority:
 *   1. CF-Connecting-IP — Cloudflare's authoritative client IP (not
 *      client-spoofable when traffic actually transits Cloudflare).
 *   2. True-Client-IP — Cloudflare Enterprise / Akamai equivalent.
 *   3. Left-most X-Forwarded-For entry — the original client per the XFF spec.
 *   4. req.ip / socket.remoteAddress — direct TCP peer (only correct when
 *      there is no proxy in front).
 *
 * Result is normalized (IPv4-mapped IPv6 prefix stripped). A native IPv6 peer
 * is returned as-is.
 */
export function getClientIp(req: Request): string {
    const cf = headerFirst(req.headers["cf-connecting-ip"]);
    if (cf) return normalizeIp(cf);

    const trueClient = headerFirst(req.headers["true-client-ip"]);
    if (trueClient) return normalizeIp(trueClient);

    const xff = headerFirst(req.headers["x-forwarded-for"]);
    if (xff) {
        const first = xff.split(",")[0]?.trim();
        if (first) return normalizeIp(first);
    }

    return normalizeIp(req.ip || req.socket?.remoteAddress || "");
}
