import { Router, Request, Response } from "express";

import { authMiddleware } from "../middleware/authMiddleware";
import { getUserPaymentTokens } from "../models/token.model";

const router = Router();

router.get("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const cards = await getUserPaymentTokens(userId);
    res.json({
      success: true,
      data: cards,
    });
  } catch (error) {
    console.error("Error fetching user cards:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

export default router;
