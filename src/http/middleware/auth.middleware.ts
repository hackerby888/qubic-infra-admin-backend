import express from "express";
import jwt from "jsonwebtoken";

declare global {
    namespace Express {
        interface Request {
            user?: {
                username?: string;
                role?: string;
            };
        }
    }
}

// Middleware to verify JWT token
export function authenticateToken(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Missing token" });
    }

    jwt.verify(
        token,
        process.env.JWT_SECRET as string,
        (err, user: any) => {
            if (err) {
                return res.status(403).json({ error: "Invalid token" });
            }
            req.user = user;
            next();
        }
    );
}
