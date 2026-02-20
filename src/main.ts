import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import morgan from "morgan";

dotenv.config();

import cardRoutes from "./modules/card/card.routes";
import feeRoutes from "./modules/fee/fee.routes";
import paymentRoutes from "./modules/payment/payment.routes";
import payoutRequestsRoutes from "./modules/payout-requests/payout-requests.routes";
import subscriptionRoutes from "./modules/subscription/subscription.routes";
import walletRoutes from "./modules/wallet/wallet.routes";
import { subscriptionRenewalService } from "./services/subscriptionRenewal.service";

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "korner-billing-service" });
});

app.use("/api/payment", paymentRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/fee", feeRoutes);
app.use("/api/v1/payout-requests", payoutRequestsRoutes);
app.use("/api/cards", cardRoutes);

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: {
      code: "SERVER_ERROR",
      message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
    },
  });
});

app.listen(Number(PORT), "::", () => {
  console.log(`korner-billing-service running on port ${PORT}`);
  subscriptionRenewalService.start();
});

export default app;
