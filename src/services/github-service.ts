import { convertServerArrayToServersListString } from "../utils/common.js";
import { logger } from "../utils/logger.js";

namespace GithubService {
    export interface GithubTag {
        name: string;
        zipball_url: string;
        tarball_url: string;
        commit: {
            sha: string;
            url: string;
        };
        node_id: string;
    }

    const GITHUB_API_URL = "https://api.github.com";
    const BRANCH = "main";

    let _github_token = process.env.GITHUB_TOKEN || "";
    let _repo = process.env.GITHUB_REPO || "";
    let _user = process.env.GITHUB_USER || "";
    let _variables: Record<string, string> = {};

    let _tags: GithubTag[] = [];
    let isPullingTags = false;

    async function fetchAndUpdateRepoVariables() {
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                const response = await fetch(
                    `${GITHUB_API_URL}/repos/${_user}/${_repo}/actions/variables`,
                    {
                        method: "GET",
                        headers: {
                            Authorization: `Bearer ${_github_token}`,
                            Accept: "application/vnd.github+json",
                        },
                    }
                );

                if (!response.ok) {
                    throw new Error(
                        `Failed to fetch repo variables: ${response.statusText}`
                    );
                }

                const data = await response.json();
                for (const variable of data.variables) {
                    _variables[variable.name] = variable.value;
                }

                logger.info("Fetched GitHub repo variables successfully.");

                for (const [key, value] of Object.entries(_variables)) {
                    logger.info(`Variable: ${key} = ${value}`);
                }

                return;
            } catch (error) {
                retryCount++;
            }
        }
    }

    export function getVariable(name: string): string {
        return _variables[name] || "";
    }

    export function getAllVariables(): Record<string, string> {
        return _variables;
    }

    export async function invokeDeployWorkflow({
        epoch,
        epochFile,
        peers,
        servers,
    }: {
        epoch: number;
        epochFile: string;
        peers: string;
        servers: string[];
    }) {
        let url = `${GITHUB_API_URL}/repos/${_user}/${_repo}/actions/workflows/deploy.yml/dispatches`;
        // Convert servers array to string format expected by the workflow input
        // NOTE: if no servers are provided, send an empty string (mean **ALL** servers will be deployed to)
        let requestingServers =
            servers.length > 0
                ? convertServerArrayToServersListString(servers)
                : "";
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${_github_token}`,
                    Accept: "application/vnd.github+json",
                },
                body: JSON.stringify({
                    ref: BRANCH,
                    inputs: {
                        configuration: "Release",
                        "build-dir": "build",
                        epoch: epoch.toString(),
                        "epoch-file": epochFile,
                        peers: peers,
                        servers: requestingServers,
                    },
                }),
            });

            if (!response.ok) {
                throw new Error(
                    `Failed to invoke deploy workflow: ${response.statusText}`
                );
            }

            logger.info("Successfully invoked deploy workflow.");
        } catch (error) {
            logger.error(
                `Error invoking deploy workflow: ${(error as Error).message}`
            );
        }
    }

    export async function pullTagsFromGithub() {
        if (isPullingTags) {
            logger.info("Already pulling tags from GitHub. Skipping...");
            return _tags;
        }
        isPullingTags = true;
        let url = `https://api.github.com/repos/${_user}/${_repo}/tags`;
        try {
            let response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch tags: ${response.statusText}`);
            }
            let data: GithubTag[] = await response.json();
            _tags = data;
            logger.info("Fetched GitHub tags successfully.");
            isPullingTags = false;
            return _tags;
        } catch (error) {
            logger.error(
                `Error fetching GitHub tags: ${(error as Error).message}`
            );
            isPullingTags = false;
            return [];
        }
    }

    export function getGithubTags() {
        return _tags;
    }

    export function getDownloadUrlForTag(tagName: string, file: string) {
        let url = `https://github.com/${_user}/${_repo}/releases/download/${tagName}/${file}`;
        return url;
    }

    export async function start() {
        if (!_github_token) {
            throw new Error("GITHUB_TOKEN is not set");
        }

        if (!_repo) {
            throw new Error("GITHUB_REPO is not set");
        }

        if (!_user) {
            throw new Error("GITHUB_USER is not set");
        }

        await fetchAndUpdateRepoVariables();
        await pullTagsFromGithub();
    }
}

export { GithubService };
