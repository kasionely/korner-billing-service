import { Router } from "express";

import { authMiddleware } from "../../middleware/authMiddleware";
import * as walletController from "./wallet.controller";

const router = Router();

router.get("/balance", authMiddleware, walletController.getBalance);
router.get("/balance/:currencyId", authMiddleware, walletController.getBalanceByCurrency);
router.get("/transactions", authMiddleware, walletController.getTransactions);
router.post("/create", authMiddleware, walletController.createWallet);
router.post("/top-up", authMiddleware, walletController.topUp);
router.post("/callback", walletController.callback);

export default router;
