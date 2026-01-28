import express from "express";
import healthRoutes from "./health.routes.js";
import authRoutes from "./auth.routes.js";
import usersRoutes from "./users.routes.js";
import serversRoutes from "./servers.routes.js";
import deploymentRoutes from "./deployment.routes.js";
import commandsRoutes from "./commands.routes.js";
import logsRoutes from "./logs.routes.js";
import nodesRoutes from "./nodes.routes.js";
import monitoringRoutes from "./monitoring.routes.js";
import automationRoutes from "./automation.routes.js";
import mapRoutes from "./map.routes.js";

export function setupRoutes(app: express.Application) {
    // Health check
    app.use("/", healthRoutes);
    
    // Authentication
    app.use("/", authRoutes);
    
    // Users management
    app.use("/", usersRoutes);
    
    // Servers management
    app.use("/", serversRoutes);
    
    // Deployment
    app.use("/", deploymentRoutes);
    
    // Commands
    app.use("/command", commandsRoutes);
    
    // Logs
    app.use("/", logsRoutes);
    
    // Nodes
    app.use("/", nodesRoutes);
    
    // Monitoring
    app.use("/", monitoringRoutes);
    
    // Automation (cron jobs)
    app.use("/", automationRoutes);
    
    // Map
    app.use("/", mapRoutes);
}
