import { Router } from "express";

import * as internalController from "./internal.controller";

const router = Router();

router.get("/subscriptions/active", internalController.getActiveSubscription);
router.get("/purchases/check", internalController.checkPurchase);

export default router;
