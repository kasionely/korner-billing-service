import { Request, Response } from "express";

import { cardService } from "./card.service";

export async function getUserCards(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const cards = await cardService.getUserCards(userId);
    res.json({ success: true, data: cards });
  } catch (error) {
    console.error("Error fetching user cards:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
}
