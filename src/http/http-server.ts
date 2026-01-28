import express from "express";
import cors from "cors";
import { logger } from "../utils/logger.js";
import { setupRoutes } from "./routes/index.js";
import fs from "fs";
import https from "https";

namespace HttpServer {
    export async function start() {
        const app = express();
        app.use(express.json());
        app.use(cors());
        const port = process.env.PORT || 3000;

        // Setup all routes
        setupRoutes(app);

        let server: any;
        if (process.env.ENV === "production") {
            logger.info("Starting HTTPS server in production mode");
            const httpsOptions = {
                key: fs.readFileSync(
                    process.env.HTTPS_KEY_PATH || "./certs/key.pem"
                ),
                cert: fs.readFileSync(
                    process.env.HTTPS_CERT_PATH || "./certs/cert.pem"
                ),
            };
            server = https.createServer(httpsOptions, app).listen(port, () => {
                logger.info(
                    `HTTPS Server is running at https://localhost:${port}`
                );
            });
        } else {
            logger.info("Starting HTTP server in development mode");
            server = app.listen(port, () => {
                logger.info(
                    `HTTP Server is running at http://localhost:${port}`
                );
            });
        }

        return server;
    }
}

export { HttpServer };
