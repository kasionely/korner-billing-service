import { db } from "../db";
import { createPaymentTransaction, updatePaymentTransaction } from "../models/payment.model";
import { createSubscription, getSubscriptionPlanPrice } from "../models/subscription.model";
import { getPaymentTokenById } from "../models/token.model";
import { mapPaymentStatus } from "../utils/statusMapper";
import {
  createPaymentRecurrentRequestBody,
  sendPaymentRecurrentRequest,
  SubscriptionConfig,
  verifyResponseSignature,
  DecodedPaymentData,
} from "../utils/subscription";

interface ExpiringSubscription {
  subscription_id: number;
  user_id: number;
  subscription_plan_id: number;
  plan_name: string;
  period: "daily" | "monthly" | "yearly";
  expired_at: Date;
  payment_method: "wallet" | "card";
  masked_pan?: string;
  price_id?: number;
  currency_id?: number;
  price?: string;
}

export class SubscriptionRenewalService {
  private intervalId: NodeJS.Timeout | null = null;
  private paymentConfig: SubscriptionConfig;

  constructor() {
    this.paymentConfig = {
      secretKey: process.env.OV_SECRET_KEY!,
      apiKey: process.env.OV_API_KEY!,
      apiUrl: process.env.OV_API_URL!,
      kornerApiUrl: process.env.API_URL!,
      kornerUrl: process.env.KORNER_URL!,
      merchantId: process.env.OV_MERCHANT_ID!,
      serviceId: process.env.OV_SERVICE_ID!,
      tokenSaveTime: process.env.OV_TOKEN_SAVE_TIME!,
    };
  }

  async getExpiringSubscriptions(): Promise<ExpiringSubscription[]> {
    try {
      const subscriptions = await db("user_subscriptions as us")
        .join("subscription_plans as sp", "us.subscription_plan_id", "sp.id")
        .leftJoin("subscription_plans_prices as spp", "sp.id", "spp.subscription_plan_id")
        .where("us.is_auto_renewal", true)
        .where("us.expired_at", ">", db.fn.now())
        .where("us.expired_at", "<=", db.raw("NOW() + INTERVAL '24 hours'"))
        .select(
          "us.id as subscription_id",
          "us.user_id",
          "us.subscription_plan_id",
          "sp.name as plan_name",
          "sp.period",
          "us.expired_at",
          "us.payment_method",
          "us.masked_pan",
          "spp.id as price_id",
          "spp.currency_id",
          "spp.price"
        );

      console.log(`Found ${subscriptions.length} subscriptions expiring in next 24 hours`);
      return subscriptions;
    } catch (error) {
      console.error("Error getting expiring subscriptions:", error);
      return [];
    }
  }

  async renewSubscription(subscription: ExpiringSubscription): Promise<boolean> {
    try {
      console.log(
        `Renewing subscription ${subscription.subscription_id} for user ${subscription.user_id}`
      );

      if (subscription.payment_method === "wallet") {
        console.log("Wallet auto-renewal not implemented yet");
        return false;
      }

      if (subscription.payment_method === "card") {
        const paymentToken = await db("payment_tokens")
          .where("user_id", subscription.user_id)
          .where("pan_masked", subscription.masked_pan)
          .orderBy("created_at", "desc")
          .first();

        if (!paymentToken) {
          console.log(
            `No payment token found for user ${subscription.user_id} with pan ${subscription.masked_pan}`
          );
          return false;
        }

        if (!subscription.price_id || !subscription.currency_id || !subscription.price) {
          console.log("Missing price information for subscription renewal");
          return false;
        }

        const amount = parseFloat(subscription.price);

        const transactionId = await createPaymentTransaction({
          userId: subscription.user_id,
          currencyId: subscription.currency_id,
          amount,
          type: "subscription",
          source: "card",
          status: "pending",
          subscriptionPlanId: subscription.subscription_plan_id,
          subscriptionPriceId: subscription.price_id,
        });

        const requestBody = createPaymentRecurrentRequestBody(
          paymentToken.token,
          amount,
          this.paymentConfig
        );

        const response = await sendPaymentRecurrentRequest(this.paymentConfig, requestBody);

        const { data: responseData, payment_id: paymentId, sign, success } = response.data;

        if (typeof success === "undefined" || !responseData || !paymentId || !sign) {
          throw new Error("Invalid API response: missing required fields");
        }

        verifyResponseSignature(responseData, sign, this.paymentConfig.secretKey);

        const decodedData: DecodedPaymentData = JSON.parse(
          Buffer.from(responseData, "base64").toString("utf-8")
        );

        await updatePaymentTransaction(transactionId, {
          orderId: decodedData.order_id,
          paymentId: paymentId,
          status: mapPaymentStatus(decodedData.payment_status),
          transactionData: decodedData,
        });

        if (
          success &&
          (decodedData.payment_status === "success" || decodedData.payment_status === "withdraw")
        ) {
          const newSubscription = await createSubscription({
            userId: subscription.user_id,
            subscriptionPlanId: subscription.subscription_plan_id,
            isAutoRenewal: true,
            paymentMethod: "card",
            maskedPan: subscription.masked_pan,
          });

          await updatePaymentTransaction(transactionId, {
            userSubscriptionId: newSubscription.id,
            status: "completed",
          });

          console.log(`Successfully renewed subscription for user ${subscription.user_id}`);
          return true;
        } else {
          console.log(`Payment failed for subscription renewal: ${decodedData.payment_status}`);
          return false;
        }
      }

      return false;
    } catch (error) {
      console.error(`Error renewing subscription ${subscription.subscription_id}:`, error);
      return false;
    }
  }

  async disableAutoRenewal(subscriptionId: number): Promise<void> {
    try {
      await db("user_subscriptions").where("id", subscriptionId).update({ is_auto_renewal: false });
      console.log(`Disabled auto-renewal for subscription ${subscriptionId}`);
    } catch (error) {
      console.error(`Error disabling auto-renewal for subscription ${subscriptionId}:`, error);
    }
  }

  async cleanupExpiredSubscriptions(monthsToKeep: number = 12): Promise<void> {
    try {
      console.log(
        `Starting cleanup of subscriptions expired more than ${monthsToKeep} months ago...`
      );

      const expiredSubscriptions = await db("user_subscriptions")
        .where("expired_at", "<", db.raw(`NOW() - INTERVAL '${monthsToKeep} months'`))
        .select("*");

      if (expiredSubscriptions.length === 0) {
        console.log("No expired subscriptions to cleanup");
        return;
      }

      console.log(`Found ${expiredSubscriptions.length} expired subscriptions to cleanup`);

      const deletedCount = await db("user_subscriptions")
        .where("expired_at", "<", db.raw(`NOW() - INTERVAL '${monthsToKeep} months'`))
        .del();

      console.log(
        `Successfully deleted ${deletedCount} expired subscriptions older than ${monthsToKeep} months`
      );
    } catch (error) {
      console.error("Error cleaning up expired subscriptions:", error);
    }
  }

  async processRenewals(): Promise<void> {
    try {
      console.log("Starting subscription renewal process...");

      const expiringSubscriptions = await this.getExpiringSubscriptions();

      if (expiringSubscriptions.length === 0) {
        console.log("No subscriptions to renew");
      } else {
        let successCount = 0;
        let failureCount = 0;

        for (const subscription of expiringSubscriptions) {
          const renewed = await this.renewSubscription(subscription);

          if (renewed) {
            successCount++;
          } else {
            failureCount++;
            await this.disableAutoRenewal(subscription.subscription_id);
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        console.log(
          `Subscription renewal completed: ${successCount} successful, ${failureCount} failed`
        );
      }

      await this.cleanupExpiredSubscriptions();
    } catch (error) {
      console.error("Error in subscription renewal process:", error);
    }
  }

  private calculateTimeUntilMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() - now.getTime();
  }

  start(): void {
    console.log("Starting subscription renewal service...");

    this.processRenewals();

    const scheduleNext = () => {
      const timeUntilMidnight = this.calculateTimeUntilMidnight();

      this.intervalId = setTimeout(() => {
        this.processRenewals();

        this.intervalId = setInterval(
          () => {
            this.processRenewals();
          },
          24 * 60 * 60 * 1000
        );
      }, timeUntilMidnight);

      const nextTime = new Date(Date.now() + timeUntilMidnight);
      console.log(`Next subscription renewal check scheduled for: ${nextTime.toLocaleString()}`);
    };

    scheduleNext();
  }

  stop(): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("Subscription renewal service stopped");
    }
  }
}

export const subscriptionRenewalService = new SubscriptionRenewalService();
