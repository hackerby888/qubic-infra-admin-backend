import express from "express";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { logger } from "../../utils/logger.js";

const router = express.Router();

const GITHUB_API = "https://api.github.com";

// Deploy is driven by a GitHub Actions workflow (deploy.yml) that SSHes the
// Swarm manager and runs a rolling `docker service update`. This endpoint just
// triggers that workflow via the GitHub API — so the web-UI path and the manual
// GitHub path use the exact same rollout mechanism. If the backend is down, the
// workflow is still triggerable directly from GitHub (the fallback).
function deployConfig() {
    return {
        repo: process.env.DEPLOY_REPO || "", // "owner/repo" of the backend repo
        workflow: process.env.DEPLOY_WORKFLOW || "deploy.yml",
        ref: process.env.DEPLOY_REF || "main",
        token: process.env.DEPLOY_GITHUB_TOKEN || "", // PAT with actions:write
    };
}

function ghHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "qubic-infra-admin",
    };
}

// Trigger a fleet rollout (admin only).
router.post("/deploy-fleet", authenticateToken, async (req, res) => {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
    }
    const { repo, workflow, ref, token } = deployConfig();
    if (!repo || !token) {
        return res.status(503).json({
            error: "Deploy not configured (set DEPLOY_REPO + DEPLOY_GITHUB_TOKEN).",
        });
    }
    const imageTag = (req.body?.imageTag as string) || "latest";
    try {
        const resp = await fetch(
            `${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}/dispatches`,
            {
                method: "POST",
                headers: {
                    ...ghHeaders(token),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ ref, inputs: { image_tag: imageTag } }),
            }
        );
        if (resp.status !== 204) {
            const text = await resp.text();
            logger.error(`Deploy dispatch failed (${resp.status}): ${text}`);
            return res.status(502).json({
                error: `GitHub dispatch failed (${resp.status}): ${text.slice(
                    0,
                    300
                )}`,
            });
        }
        logger.warn(
            `🚀 Fleet deploy triggered by ${req.user.username} (tag: ${imageTag})`
        );
        res.json({
            message: `Fleet deploy triggered (tag: ${imageTag}).`,
            actionsUrl: `https://github.com/${repo}/actions/workflows/${workflow}`,
        });
    } catch (error) {
        logger.error(`Deploy dispatch error: ${(error as Error).message}`);
        res.status(500).json({ error: (error as Error).message });
    }
});

// Recent deploy runs (admin) — powers the System Health deploy panel.
router.get("/deploy-fleet/runs", authenticateToken, async (req, res) => {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
    }
    const { repo, workflow, token } = deployConfig();
    if (!repo || !token) {
        return res.json({ configured: false, runs: [] });
    }
    try {
        const resp = await fetch(
            `${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}/runs?per_page=5`,
            { headers: ghHeaders(token) }
        );
        if (!resp.ok) {
            const text = await resp.text();
            return res.status(502).json({
                error: `GitHub API ${resp.status}: ${text.slice(0, 200)}`,
            });
        }
        const data: any = await resp.json();
        const runs = (data.workflow_runs || []).map((r: any) => ({
            id: r.id,
            status: r.status, // queued | in_progress | completed
            conclusion: r.conclusion, // success | failure | cancelled | null
            createdAt: r.created_at,
            actor: r.actor?.login,
            event: r.event,
            htmlUrl: r.html_url,
        }));
        res.json({ configured: true, runs });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

export default router;
