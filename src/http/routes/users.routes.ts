import express from "express";
import { Mongodb } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";

const router = express.Router();

// Get all operators (admin only)
router.get("/operators", authenticateToken, async (req, res) => {
    try {
        // check if admin
        if (!req.user || req.user.role !== "admin") {
            res.status(403).json({
                error: "Admin privileges required",
            });
            return;
        }
        const operators = await Mongodb.getUsersCollection()
            .find({})
            .project({ _id: 0, passwordHash: 0 })
            .toArray();
        res.json({ operators });
    } catch (error) {
        logger.error(
            `Fetch operators error: ${(error as Error).message}`
        );
        res.status(500).json({ error: "Internal server error" });
        return;
    }
});

// Delete an operator (admin only)
router.delete("/operators", authenticateToken, async (req, res) => {
    try {
        if (!req.user || req.user.role !== "admin") {
            res.status(403).json({
                error: "Admin privileges required",
            });
            return;
        }
        const { username } = req.body;
        if (!username) {
            res.status(400).json({
                error: "Missing username",
            });
            return;
        }
        await Mongodb.getUsersCollection().deleteOne({
            username,
        });
        res.json({ message: "User deleted successfully" });
    } catch (error) {
        logger.error(
            `Delete operator error: ${(error as Error).message}`
        );
        res.status(500).json({ error: "Internal server error" });
        return;
    }
});

// Create a new operator (admin only)
router.post("/operators", authenticateToken, async (req, res) => {
    try {
        if (!req.user || req.user.role !== "admin") {
            res.status(403).json({
                error: "Admin privileges required",
            });
            return;
        }
        const { username, passwordHash, role } = req.body;
        if (!username || !passwordHash || !role) {
            res.status(400).json({
                error: "Missing username, passwordHash, or role",
            });
            return;
        }

        await Mongodb.createUser({
            username,
            passwordHash,
            role,
            insertedAt: Date.now(),
        });
        res.json({ message: "User registered successfully" });
    } catch (error) {
        logger.error(
            `Registration error: ${(error as Error).message}`
        );
        res.status(500).json({
            error:
                "Internal server error: " +
                (error as Error).message,
        });
        return;
    }
});

// Get current user info
router.get("/my-info", authenticateToken, async (req, res) => {
    try {
        let operator = req.user?.username;
        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }

        let userDoc = await Mongodb.getUsersCollection().findOne(
            { username: operator },
            { projection: { _id: 0, passwordHash: 0 } }
        );
        res.json({ user: userDoc });
    } catch (error) {
        logger.error(
            `Error fetching my info: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to fetch user info " + error,
        });
    }
});

export default router;
