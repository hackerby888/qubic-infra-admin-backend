import express from "express";

const router = express.Router();

// Health check endpoint
router.get("/", (req, res) => {
    res.send("Qubic iz da bes', homie!");
});

export default router;
