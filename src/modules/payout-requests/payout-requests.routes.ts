import { Router } from "express";

import { authMiddleware } from "../../middleware/authMiddleware";
import * as payoutRequestsController from "./payout-requests.controller";

const router = Router();

router.post("/", authMiddleware, payoutRequestsController.create);
router.get("/admin", authMiddleware, payoutRequestsController.getAdminList);
router.get("/admin/:payoutRequestId", authMiddleware, payoutRequestsController.getAdminDetails);
router.patch("/admin/:payoutRequestId/status", authMiddleware, payoutRequestsController.updateStatus);

export default router;
