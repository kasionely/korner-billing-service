import { Request, Response } from "express";

import { getActiveSubscriptionInfo } from "../../models/subscription.model";
import { hasUserPurchasedBar } from "../../models/payment.model";

export async function getActiveSubscription(req: Request, res: Response): Promise<void> {
  try {
    const userId = Number(req.query.userId);
    if (!userId || isNaN(userId)) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid userId" } });
      return;
    }

    const info = await getActiveSubscriptionInfo(userId);
    res.status(200).json(info);
  } catch (error) {
    console.error("Error fetching active subscription:", error);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Internal error" } });
  }
}

export async function checkPurchase(req: Request, res: Response): Promise<void> {
  try {
    const userId = Number(req.query.userId);
    const barId = req.query.barId as string;

    if (!userId || isNaN(userId) || !barId) {
      res
        .status(400)
        .json({ error: { code: "VALIDATION_ERROR", message: "Invalid userId or barId" } });
      return;
    }

    const hasPurchased = await hasUserPurchasedBar(userId, barId);
    res.status(200).json({ hasPurchased });
  } catch (error) {
    console.error("Error checking purchase:", error);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Internal error" } });
  }
}
