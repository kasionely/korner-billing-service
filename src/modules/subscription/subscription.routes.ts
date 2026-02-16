import { Router } from "express";

import { authMiddleware } from "../../middleware/authMiddleware";
import * as subscriptionController from "./subscription.controller";

const router = Router();

router.get("/", subscriptionController.getPlans);
router.get("/info", authMiddleware, subscriptionController.getInfo);
router.post("/create", authMiddleware, subscriptionController.create);
router.post("/status", authMiddleware, subscriptionController.getStatus);
router.post("/recurrent", authMiddleware, subscriptionController.recurrent);
router.post("/callback", subscriptionController.callback);
router.get("/history", authMiddleware, subscriptionController.getHistory);
router.delete("/cancel", authMiddleware, subscriptionController.cancel);
router.patch("/auto-renewal", authMiddleware, subscriptionController.updateAutoRenewal);

export default router;
