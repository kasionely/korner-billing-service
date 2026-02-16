import { Router } from "express";

import { authMiddleware } from "../../middleware/authMiddleware";
import * as cardController from "./card.controller";

const router = Router();

router.get("/", authMiddleware, cardController.getUserCards);

export default router;
