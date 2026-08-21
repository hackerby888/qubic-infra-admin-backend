import { logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";
import { LeaderService } from "./leader-service.js";
import { NodeService } from "./node-service.js";

namespace CloudflareService {
    const POOL_SYNC_INTERVAL_MS = 10_000;
    // Node pollers need a moment after boot to fill _status / _statusCheckin. Syncing before that
    // sees a half-built fleet and swaps a healthy origin for no reason, and every swap costs the
    // replacement a monitor consecutive_up warm-up before it can serve.
    const STARTUP_WARM_UP_MS = 60_000;
    const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";
    const REQUEST_TIMEOUT_MS = 10_000;

    // Bob nodes only listen on 40420, never 80/443. Load balancer endpoints carry their own
    // port field, so no Origin Rule is needed - but omitting it would default the origin to 443.
    const BOB_NODE_PORT = 40420;

    // Cloudflare bills per endpoint, so the pool size is whatever the subscription was provisioned
    // for. We read the live origin count instead of guessing, and never push more than that.
    const DRY_RUN_ORIGIN_CAP = 3;

    let _accountId = process.env.CF_ACCOUNT_ID || "";
    let _bobPoolId = process.env.CF_BOB_POOL_ID || "";
    let _apiToken = process.env.CF_API_TOKEN || "";
    let _lastPushedServers: string[] = [];

    function isConfigured(): boolean {
        return Boolean(_accountId && _bobPoolId && _apiToken);
    }

    function poolUrl(): string {
        return `${CLOUDFLARE_API_URL}/accounts/${_accountId}/load_balancers/pools/${_bobPoolId}`;
    }

    function authHeaders(): Record<string, string> {
        return {
            Authorization: `Bearer ${_apiToken}`,
            "Content-Type": "application/json",
        };
    }

    // Membership is sticky on purpose. Bob nodes leapfrog each other every second, so picking the
    // "top N by tick" every cycle would rewrite the pool constantly and re-pin every sticky client.
    // Keep whoever is still servable, backfill only the slots that actually opened up.
    function selectPoolMembers(servableServers: string[], originCap: number): string[] {
        const servable = new Set(servableServers);
        const kept = _lastPushedServers.filter((server) => servable.has(server));
        const additions = servableServers.filter((server) => !kept.includes(server));

        return [...kept, ...additions].slice(0, originCap);
    }

    // Addresses the pool currently serves. Cloudflare rejects a PATCH that exceeds the subscribed
    // endpoint count, so the live pool is both the size limit and our starting membership.
    async function fetchPoolOrigins(): Promise<string[]> {
        const response = await fetch(poolUrl(), {
            headers: authHeaders(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`${response.status} ${await response.text()}`);
        }

        const body = (await response.json()) as { result?: { origins?: { address?: string }[] } };

        return (body.result?.origins || []).map((origin) => origin.address || "").filter(Boolean);
    }

    async function pushPoolOrigins(members: string[]): Promise<void> {
        const origins = members.map((server) => ({
            name: `bob-${server.replace(/\./g, "-")}`,
            address: server,
            port: BOB_NODE_PORT,
            enabled: true,
            weight: 1,
        }));

        const response = await fetch(poolUrl(), {
            method: "PATCH",
            headers: authHeaders(),
            body: JSON.stringify({ origins }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`${response.status} ${await response.text()}`);
        }
    }

    // Keeps the bob.qubic.global load balancer pool in sync with the bob nodes we consider
    // servable. Cloudflare cannot tell which node holds the highest tick, so we decide here.
    async function watchAndSyncBobPool() {
        await sleep(STARTUP_WARM_UP_MS);

        while (true) {
            await sleep(POOL_SYNC_INTERVAL_MS);

            // Leader-only, or both instances would push the same pool. Checked per iteration
            // like watchBobNodes, not via onBecomeLeader, so a leader flap cannot double-fire.
            if (!LeaderService.isLeader()) {
                continue;
            }

            const servableServers = NodeService.getServableBobNodes();

            // Never push an empty pool: Cloudflare would mark it unhealthy and take
            // bob.qubic.global down. Keeping the last known-good set is safer.
            if (servableServers.length === 0) {
                logger.error("Bob LB sync: no servable nodes, leaving pool as-is");
                continue;
            }

            try {
                const poolOrigins = isConfigured() ? await fetchPoolOrigins() : [];
                const originCap = isConfigured() ? Math.max(1, poolOrigins.length) : DRY_RUN_ORIGIN_CAP;

                // First cycle after a restart: adopt whatever the pool already serves. Otherwise we
                // would swap out a healthy origin for no reason, and its replacement has to re-pass
                // the monitor consecutive_up times before it can take traffic.
                if (_lastPushedServers.length === 0 && poolOrigins.length > 0) {
                    _lastPushedServers = poolOrigins;
                }

                const members = selectPoolMembers(servableServers, originCap);

                if (members.join(",") === _lastPushedServers.join(",")) {
                    continue;
                }

                if (!isConfigured()) {
                    logger.info(`Bob LB sync (dry run): would set ${members.length}/${originCap} origins: ${members.join(",")}`);
                    _lastPushedServers = members;
                    continue;
                }

                await pushPoolOrigins(members);
                _lastPushedServers = members;
                logger.info(`Bob LB pool updated: ${members.length}/${originCap} origins: ${members.join(",")}`);
            } catch (error) {
                // Leave _lastPushedServers untouched so the next tick retries.
                logger.error(`Bob LB sync failed: ${(error as Error).message}`);
            }
        }
    }

    export async function start() {
        if (!isConfigured()) {
            logger.warn("Cloudflare LB sync disabled (CF_ACCOUNT_ID / CF_BOB_POOL_ID / CF_API_TOKEN unset); logging intended pool state only");
        }

        watchAndSyncBobPool();
        logger.info("☁️ CloudflareService started.");
    }
}

export { CloudflareService };
