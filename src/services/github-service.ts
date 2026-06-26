import { MongoDbTypes } from "../database/db.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";

namespace GithubService {
    export interface GithubAsset {
        name: string;
        browser_download_url: string;
        size: number;
        content_type: string;
    }

    export interface GithubTag {
        name: string;
        zipball_url: string;
        tarball_url: string;
        commit: {
            sha: string;
            url: string;
        };
        node_id: string;
        // Downloadable binary assets of this tag's release (avx2/avx512/arm/...),
        // filtered to runnable binaries. Empty if the tag has no release.
        assets?: GithubAsset[];
    }

    const GITHUB_API_URL = "https://api.github.com";
    const BRANCH = "main";

    let _github_token = process.env.GITHUB_TOKEN || "";
    let _lite_node_repo = process.env.GITHUB_LITE_NODE_REPO || "";
    let _lite_node_user = process.env.GITHUB_LITE_NODE_USER || "";
    let _bob_node_repo = process.env.GITHUB_BOB_NODE_REPO || "";
    let _bob_node_user = process.env.GITHUB_BOB_NODE_USER || "";
    let _variables: Record<string, string> = {};

    let _tags: Partial<Record<MongoDbTypes.ServiceType, GithubTag[]>> = {};
    let isPullingTags = false;

    // async function fetchAndUpdateRepoVariables() {
    //     let retryCount = 0;
    //     const maxRetries = 3;

    //     while (retryCount < maxRetries) {
    //         try {
    //             const response = await fetch(
    //                 `${GITHUB_API_URL}/repos/${_user}/${_repo}/actions/variables`,
    //                 {
    //                     method: "GET",
    //                     headers: {
    //                         Authorization: `Bearer ${_github_token}`,
    //                         Accept: "application/vnd.github+json",
    //                     },
    //                 }
    //             );

    //             if (!response.ok) {
    //                 throw new Error(
    //                     `Failed to fetch repo variables: ${response.statusText}`
    //                 );
    //             }

    //             const data = await response.json();
    //             for (const variable of data.variables) {
    //                 _variables[variable.name] = variable.value;
    //             }

    //             logger.info("Fetched GitHub repo variables successfully.");

    //             for (const [key, value] of Object.entries(_variables)) {
    //                 logger.info(`Variable: ${key} = ${value}`);
    //             }

    //             return;
    //         } catch (error) {
    //             retryCount++;
    //         }
    //     }
    // }

    export function getVariable(name: string): string {
        return _variables[name] || "";
    }

    export function getAllVariables(): Record<string, string> {
        return _variables;
    }

    // export async function invokeDeployWorkflow({
    //     epoch,
    //     epochFile,
    //     peers,
    //     servers,
    // }: {
    //     epoch: number;
    //     epochFile: string;
    //     peers: string;
    //     servers: string[];
    // }) {
    //     let url = `${GITHUB_API_URL}/repos/${_user}/${_repo}/actions/workflows/deploy.yml/dispatches`;
    //     // Convert servers array to string format expected by the workflow input
    //     // NOTE: if no servers are provided, send an empty string (mean **ALL** servers will be deployed to)
    //     let requestingServers =
    //         servers.length > 0
    //             ? convertServerArrayToServersListString(servers)
    //             : "";
    //     try {
    //         const response = await fetch(url, {
    //             method: "POST",
    //             headers: {
    //                 Authorization: `Bearer ${_github_token}`,
    //                 Accept: "application/vnd.github+json",
    //             },
    //             body: JSON.stringify({
    //                 ref: BRANCH,
    //                 inputs: {
    //                     configuration: "Release",
    //                     "build-dir": "build",
    //                     epoch: epoch.toString(),
    //                     "epoch-file": epochFile,
    //                     peers: peers,
    //                     servers: requestingServers,
    //                 },
    //             }),
    //         });

    //         if (!response.ok) {
    //             throw new Error(
    //                 `Failed to invoke deploy workflow: ${response.statusText}`
    //             );
    //         }

    //         logger.info("Successfully invoked deploy workflow.");
    //     } catch (error) {
    //         logger.error(
    //             `Error invoking deploy workflow: ${(error as Error).message}`
    //         );
    //     }
    // }

    function githubHeaders(): Record<string, string> {
        // Public repos: do NOT attach Authorization. An invalid/expired
        // GITHUB_TOKEN here makes GitHub 401 the request and we lose the entire
        // tag list (these endpoints work fine unauthenticated).
        return {
            Accept: "application/vnd.github+json",
        };
    }

    // Non-binary release assets GitHub (or the build) attaches alongside the
    // actual binaries: checksums, signatures, sboms, notes. Source archives are
    // already excluded by GitHub from a release's `assets`.
    const NON_BINARY_ASSET_EXT = [
        ".sha256",
        ".sha512",
        ".sha1",
        ".md5",
        ".sig",
        ".asc",
        ".pem",
        ".txt",
        ".json",
        ".yml",
        ".yaml",
        ".sbom",
        ".pdf",
        ".exe", // Windows build; the fleet is Linux
    ];
    function filterBinaryAssets(assets: GithubAsset[]): GithubAsset[] {
        return assets.filter((a) => {
            let name = (a.name || "").toLowerCase();
            if (name.includes("checksum") || name.includes("source")) {
                return false;
            }
            return !NON_BINARY_ASSET_EXT.some((ext) => name.endsWith(ext));
        });
    }

    export async function pullTagsFromGithub(
        service: MongoDbTypes.ServiceType
    ): Promise<GithubTag[]> {
        if (isPullingTags) {
            await new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                    if (!isPullingTags) {
                        clearInterval(checkInterval);
                        resolve(true);
                    }
                }, 50);
            });
            return _tags[service] || [];
        }
        isPullingTags = true;
        let repoBase = ``;
        if (service === MongoDbTypes.ServiceType.LiteNode) {
            repoBase = `${GITHUB_API_URL}/repos/${_lite_node_user}/${_lite_node_repo}`;
        } else if (service === MongoDbTypes.ServiceType.BobNode) {
            repoBase = `${GITHUB_API_URL}/repos/${_bob_node_user}/${_bob_node_repo}`;
        } else {
            logger.error("Invalid service type for pulling GitHub tags.");
            isPullingTags = false;
            return [];
        }
        try {
            let response = await fetch(`${repoBase}/tags`, {
                headers: githubHeaders(),
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch tags: ${response.statusText}`);
            }
            let data: GithubTag[] = await response.json();

            // Enrich each tag with its release's binary assets so the deploy UI
            // can pick a specific build. Best-effort: on failure assets stay
            // empty and deploy falls back to the default binary name.
            try {
                let releasesRes = await fetch(
                    `${repoBase}/releases?per_page=100`,
                    { headers: githubHeaders() }
                );
                if (releasesRes.ok) {
                    let releases: {
                        tag_name: string;
                        assets: GithubAsset[];
                    }[] = await releasesRes.json();
                    let assetsByTag: Record<string, GithubAsset[]> = {};
                    for (let release of releases) {
                        assetsByTag[release.tag_name] = filterBinaryAssets(
                            release.assets || []
                        );
                    }
                    for (let tag of data) {
                        tag.assets = assetsByTag[tag.name] || [];
                    }
                }
            } catch (assetError) {
                logger.warn(
                    `Failed to fetch release assets: ${
                        (assetError as Error).message
                    }`
                );
            }

            _tags[service] = data;
            logger.info("Fetched GitHub tags successfully.");
            isPullingTags = false;
            return _tags[service];
        } catch (error) {
            logger.error(
                `Error fetching GitHub tags: ${(error as Error).message}`
            );
            isPullingTags = false;
            return [];
        }
    }

    export function getGithubTags(service: MongoDbTypes.ServiceType) {
        return _tags[service];
    }

    export function getDownloadUrlForTag(
        tagName: string,
        file: string,
        service: MongoDbTypes.ServiceType
    ) {
        let url = "";
        if (service === MongoDbTypes.ServiceType.LiteNode) {
            url = `https://github.com/${_lite_node_user}/${_lite_node_repo}/releases/download/${tagName}/${file}`;
        } else if (service === MongoDbTypes.ServiceType.BobNode) {
            url = `https://github.com/${_bob_node_user}/${_bob_node_repo}/releases/download/${tagName}/${file}`;
        } else {
            logger.error("Invalid service type for constructing download URL.");
            throw new Error("Invalid service type");
        }
        return url;
    }

    // Re-pull tags periodically on EVERY instance so a manual
    // /refresh-github-tags handled by one instance converges across the fleet
    // (each instance keeps its own in-memory _tags cache). Idempotent external GET.
    const TAGS_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
    async function watchAndRefreshTags() {
        while (true) {
            await sleep(TAGS_REFRESH_INTERVAL_MS);
            for (const service of [
                MongoDbTypes.ServiceType.LiteNode,
                MongoDbTypes.ServiceType.BobNode,
            ]) {
                try {
                    await pullTagsFromGithub(service);
                } catch (error) {
                    logger.error(
                        `Error refreshing GitHub tags: ${
                            (error as Error).message
                        }`
                    );
                }
            }
        }
    }

    export async function start() {
        if (!_github_token) {
            throw new Error("GITHUB_TOKEN is not set");
        }

        if (!_lite_node_repo) {
            throw new Error("GITHUB_LITE_NODE_REPO is not set");
        }
        if (!_lite_node_user) {
            throw new Error("GITHUB_LITE_NODE_USER is not set");
        }
        if (!_bob_node_repo) {
            throw new Error("GITHUB_BOB_NODE_REPO is not set");
        }
        if (!_bob_node_user) {
            throw new Error("GITHUB_BOB_NODE_USER is not set");
        }

        // await fetchAndUpdateRepoVariables();
        for (const service of [
            MongoDbTypes.ServiceType.LiteNode,
            MongoDbTypes.ServiceType.BobNode,
        ]) {
            await pullTagsFromGithub(service);
        }
        watchAndRefreshTags();
    }
}

export { GithubService };
