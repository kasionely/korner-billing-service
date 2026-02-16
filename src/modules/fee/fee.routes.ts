import { Router } from "express";

import { authMiddleware } from "../../middleware/authMiddleware";
import * as feeController from "./fee.controller";

const router = Router();

router.get("/currency/:currencyId", feeController.getForCurrency);
router.get("/all", feeController.getAll);
router.post("/calculate", feeController.calculate);
router.get("/currency/:currencyId/history", authMiddleware, feeController.getHistory);
router.post("/create", feeController.createFee);
router.put("/:feeId", feeController.updateFee);

export default router;
