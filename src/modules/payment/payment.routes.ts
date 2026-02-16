import { Router } from "express";

import { authMiddleware } from "../../middleware/authMiddleware";
import * as paymentController from "./payment.controller";

const router = Router();

router.post("/create", authMiddleware, paymentController.createPayment);
router.post("/status", authMiddleware, paymentController.getStatus);
router.post("/callback", paymentController.callback);

export default router;
