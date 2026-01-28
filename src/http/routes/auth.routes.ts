import express from "express";
import jwt from "jsonwebtoken";
import { Mongodb } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";

const router = express.Router();

// Login endpoint
router.post("/login", async (req, res) => {
    try {
        const { username, passwordHash } = req.body;
        if (!username || !passwordHash) {
            res.status(400).json({
                error: "Missing username or passwordHash",
            });
            return;
        }

        const user = await Mongodb.tryLogin(username, passwordHash);
        if (!user) {
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }

        const token = jwt.sign(
            { username: user.username, role: user.role },
            process.env.JWT_SECRET as string
        );
        res.json({ token });
    } catch (error) {
        logger.error(`Login error: ${(error as Error).message}`);
        res.status(500).json({ error: "Internal server error" });
        return;
    }
});

// Set SSH key endpoint
router.post("/set-ssh-key", authenticateToken, async (req, res) => {
    try {
        let operator = req.user?.username;
        let sshPrivateKey = req.body.sshPrivateKey as string;
        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }
        if (!sshPrivateKey) {
            res.status(400).json({
                error: "No SSH private key provided",
            });
            return;
        }

        await Mongodb.getUsersCollection().updateOne(
            { username: operator },
            { $set: { currentsshPrivateKey: sshPrivateKey } }
        );

        res.json({
            message: "SSH private key updated successfully",
        });
    } catch (error) {
        logger.error(
            `Error setting SSH private key: ${
                (error as Error).message
            }`
        );
        res.status(500).json({
            error: "Failed to set SSH private key " + error,
        });
    }
});

export default router;
