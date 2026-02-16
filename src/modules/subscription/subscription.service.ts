import { db } from "../../db";
import {
  createPaymentTransaction,
  getTransactionById,
  getTransactionByOrderId,
  updatePaymentTransaction,
} from "../../models/payment.model";
import {
  getAllSubscriptionPlansWithPrices,
  createSubscription,
  getSubscriptionPlanPrice,
  deleteSubscription,
  cancelSubscription,
  getSubscriptionInfoByTransactionId,
  getActiveSubscriptionInfo,
  getUserSubscriptionHistory,
} from "../../models/subscription.model";
import { createToken, getPaymentTokenById } from "../../models/token.model";
import { checkUserBalance, deductUserWalletForSubscription } from "../../models/wallet.model";
import { lokiService } from "../../utils/lokiService";
import { ERROR_CODES } from "../../utils/errorCodes";
import { mapPaymentStatus } from "../../utils/statusMapper";
import {
  verifyResponseSignature,
  DecodedPaymentData,
  sendPaymentCreateRequest,
  createPaymentStatusRequestBody,
  sendPaymentStatusRequest,
  sendPaymentRecurrentRequest,
  createPaymentRecurrentRequestBody,
  DecodedCallbackData,
  createSubscriptionRequestBody,
  SubscriptionConfig,
} from "../../utils/subscription";

export interface CreateSubscriptionBody {
  email: string;
  payment_type: "wallet" | "token" | "card";
  plan_id: number;
  price_id: number;
  token_id?: number;
  success_url?: string;
  failure_url?: string;
}

const paymentConfig: SubscriptionConfig = {
  secretKey: process.env.OV_SECRET_KEY!,
  apiKey: process.env.OV_API_KEY!,
  apiUrl: process.env.OV_API_URL!,
  kornerApiUrl: process.env.API_URL!,
  kornerUrl: process.env.KORNER_URL!,
  merchantId: process.env.OV_MERCHANT_ID!,
  serviceId: process.env.OV_SERVICE_ID!,
  tokenSaveTime: process.env.OV_TOKEN_SAVE_TIME!,
};

export const subscriptionService = {
  async getPlans() {
    return getAllSubscriptionPlansWithPrices();
  },

  async getInfo(userId: number) {
    return getActiveSubscriptionInfo(userId);
  },

  async create(userId: number, body: CreateSubscriptionBody) {
    const { email, payment_type, plan_id, price_id, token_id, success_url, failure_url } = body;

    if (!payment_type || !plan_id || !price_id) {
      throw Object.assign(new Error("Missing required fields: payment_type, plan_id, price_id"), { statusCode: 400 });
    }

    if (payment_type === "token" && !token_id) {
      throw Object.assign(new Error("token_id is required when payment_type is 'token'"), { statusCode: 400 });
    }

    const planPrice = await getSubscriptionPlanPrice(plan_id, price_id);
    if (!planPrice) {
      throw Object.assign(new Error("Subscription plan or price not found"), { statusCode: 404 });
    }

    const amount = parseFloat(planPrice.price);

    const transactionId = await createPaymentTransaction({
      userId,
      currencyId: planPrice.currency_id,
      amount,
      type: "subscription",
      source: payment_type === "wallet" ? "wallet" : "card",
      status: "pending",
      subscriptionPlanId: plan_id,
      subscriptionPriceId: price_id,
    });

    switch (payment_type) {
      case "wallet": {
        const balanceCheck = await checkUserBalance(userId, planPrice.currency_id, amount);

        if (!balanceCheck.hasEnoughBalance) {
          throw Object.assign(
            new Error(`Insufficient balance. Current balance: ${balanceCheck.currentBalance} ${planPrice.currency_code}, Required: ${amount} ${planPrice.currency_code}`),
            { statusCode: 400 }
          );
        }

        const subscription = await createSubscription({
          userId,
          subscriptionPlanId: plan_id,
          isAutoRenewal: true,
          paymentMethod: "wallet",
        });

        const deductionResult = await deductUserWalletForSubscription(userId, planPrice.currency_id, amount, subscription.id);

        if (!deductionResult.success) {
          await deleteSubscription(subscription.id);
          throw new Error(`Failed to deduct balance: ${deductionResult.error}`);
        }

        await updatePaymentTransaction(transactionId, {
          userSubscriptionId: subscription.id,
          status: "completed",
        });

        lokiService.logSubscriptionPurchase({
          userId,
          planId: plan_id,
          priceId: price_id,
          paymentType: "wallet",
          amount,
          currency: planPrice.currency_code,
          subscriptionId: subscription.id,
          transactionId: deductionResult.transactionId,
          success: true,
        });

        return {
          payment_type: "wallet",
          data: {
            subscription_id: subscription.id,
            transaction_id: deductionResult.transactionId,
            amount_deducted: amount,
            currency: planPrice.currency_code,
            remaining_balance: (balanceCheck.currentBalance - amount).toString(),
          },
        };
      }

      case "token": {
        const paymentToken = await getPaymentTokenById(token_id!, userId);
        if (!paymentToken) {
          throw Object.assign(new Error("Payment token not found or doesn't belong to user"), { statusCode: 404 });
        }

        if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
          throw new Error("Missing required environment variables");
        }

        const requestBodyToken = createPaymentRecurrentRequestBody(paymentToken.token, amount, paymentConfig);
        const responseToken = await sendPaymentRecurrentRequest(paymentConfig, requestBodyToken);

        const { data: dataToken, payment_id: paymentIdToken, sign: signToken, success: successToken } = responseToken.data;

        if (typeof successToken === "undefined" || !dataToken || !paymentIdToken || !signToken) {
          throw new Error("Invalid API response: missing required fields");
        }

        verifyResponseSignature(dataToken, signToken, paymentConfig.secretKey);

        const decodedDataToken: DecodedPaymentData = JSON.parse(Buffer.from(dataToken, "base64").toString("utf-8"));

        const isPaymentSuccessful =
          successToken &&
          (decodedDataToken.payment_status === "success" ||
            decodedDataToken.payment_status === "withdraw" ||
            decodedDataToken.operation_status === "success");

        if (isPaymentSuccessful) {
          const subscription = await createSubscription({
            userId,
            subscriptionPlanId: plan_id,
            isAutoRenewal: true,
            paymentMethod: "card",
            maskedPan: paymentToken.pan_masked,
          });

          await updatePaymentTransaction(transactionId, {
            orderId: decodedDataToken.order_id,
            paymentId: paymentIdToken,
            status: "completed",
            transactionData: decodedDataToken,
            userSubscriptionId: subscription.id,
          });

          lokiService.logSubscriptionPurchase({
            userId,
            planId: plan_id,
            priceId: price_id,
            paymentType: "token",
            amount,
            currency: "KZT",
            subscriptionId: subscription.id,
            transactionId,
            paymentId: paymentIdToken,
            success: true,
          });

          return {
            payment_type: "token",
            isPaymentSuccessful: true,
            data: {
              message: "Token payment was successful and subscription created",
              payment_id: paymentIdToken,
              data: decodedDataToken,
              sign: signToken,
              subscription_id: subscription.id,
            },
          };
        } else {
          lokiService.logSubscriptionPurchase({
            userId,
            planId: plan_id,
            priceId: price_id,
            paymentType: "token",
            amount,
            currency: "KZT",
            transactionId,
            paymentId: paymentIdToken,
            success: false,
            error: `Payment status: ${decodedDataToken.payment_status}, operation status: ${decodedDataToken.operation_status}`,
          });

          await updatePaymentTransaction(transactionId, {
            orderId: decodedDataToken.order_id,
            paymentId: paymentIdToken,
            status: mapPaymentStatus(decodedDataToken.payment_status),
            transactionData: decodedDataToken,
          });

          return {
            payment_type: "token",
            isPaymentSuccessful: false,
            data: {
              message: "Token payment failed",
              payment_id: paymentIdToken,
              data: decodedDataToken,
              sign: signToken,
            },
          };
        }
      }

      case "card": {
        if (
          !paymentConfig.secretKey ||
          !paymentConfig.apiKey ||
          !paymentConfig.apiUrl ||
          !paymentConfig.kornerApiUrl ||
          !paymentConfig.kornerUrl ||
          !paymentConfig.merchantId ||
          !paymentConfig.serviceId
        ) {
          throw new Error("Missing required environment variables");
        }

        const requestBody = createSubscriptionRequestBody(amount, email, transactionId, paymentConfig, { success_url, failure_url });
        const response = await sendPaymentCreateRequest(paymentConfig, requestBody);

        const { data, payment_id, sign, success } = response.data;

        if (typeof success === "undefined" || !data || !payment_id || !sign) {
          throw new Error("Invalid API response: missing required fields");
        }

        verifyResponseSignature(data, sign, paymentConfig.secretKey);

        const decodedData: DecodedPaymentData = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));

        await updatePaymentTransaction(transactionId, {
          orderId: decodedData.order_id,
          paymentId: payment_id,
          status: mapPaymentStatus(decodedData.payment_status),
          transactionData: decodedData,
        });

        lokiService.logSubscriptionPurchase({
          userId,
          planId: plan_id,
          priceId: price_id,
          paymentType: "card",
          amount,
          currency: planPrice.currency_code,
          transactionId,
          paymentId: payment_id,
          success,
          error: success ? undefined : `Payment status: ${decodedData.payment_status}`,
        });

        return {
          payment_type: "card",
          isPaymentSuccessful: success,
          data: {
            message: success ? "Payment was successful" : "Payment failed",
            payment_id,
            data: decodedData,
            sign,
          },
        };
      }

      default:
        throw Object.assign(new Error("Invalid payment_type. Must be 'wallet', 'token', or 'card'"), { statusCode: 400 });
    }
  },

  async getStatus(transactionId: string) {
    if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
      throw new Error("Missing required environment variables");
    }
    if (!transactionId) throw new Error("Missing required fields: transactionId");

    const transaction = await getTransactionById(Number(transactionId));
    if (!transaction || !transaction.order_id) throw new Error("Transaction not found");

    const requestBody = createPaymentStatusRequestBody(transaction.order_id, paymentConfig);
    const response = await sendPaymentStatusRequest(paymentConfig, requestBody);

    const { data, sign, success } = response.data;

    if (typeof success === "undefined" || !data || !sign) throw new Error("Invalid API response: missing required fields");

    verifyResponseSignature(data, sign, paymentConfig.secretKey);

    const decodedData: DecodedPaymentData = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));

    return { success, data: decodedData, sign };
  },

  async recurrent(userId: number, amount: number, token: string) {
    if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
      throw new Error("Missing required environment variables");
    }

    const requestBody = createPaymentRecurrentRequestBody(token, amount, paymentConfig);
    const response = await sendPaymentRecurrentRequest(paymentConfig, requestBody);

    const { data, payment_id, sign, success } = response.data;

    if (typeof success === "undefined" || !data || !payment_id || !sign) {
      throw new Error("Invalid API response: missing required fields");
    }

    verifyResponseSignature(data, sign, paymentConfig.secretKey);

    const decodedData: DecodedPaymentData = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));

    return { success, payment_id, data: decodedData, sign };
  },

  async callback(data: string, sign: string) {
    let decodedData: DecodedCallbackData;
    try {
      decodedData = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));
    } catch (error) {
      throw Object.assign(new Error("Invalid data format"), { statusCode: 400 });
    }

    verifyResponseSignature(data, sign, paymentConfig.secretKey);

    const transaction = await getTransactionByOrderId(decodedData.order_id);
    if (!transaction) {
      throw Object.assign(new Error("Transaction not found"), { statusCode: 404 });
    }

    console.log("decodedData", decodedData);

    if (decodedData.operation_status === "success") {
      console.log("creating a token");
      await createToken({
        userId: transaction.user_id,
        // @ts-ignore
        token: decodedData.recurrent_token,
        // @ts-ignore
        expired_at: decodedData.payment_date,
        // @ts-ignore
        amount: decodedData.amount,
        pan_masked: decodedData.payer_info.pan_masked,
      });

      const subscriptionInfo = await getSubscriptionInfoByTransactionId(transaction.id);

      if (subscriptionInfo) {
        try {
          const subscription = await createSubscription({
            userId: transaction.user_id,
            subscriptionPlanId: subscriptionInfo.plan_id,
            isAutoRenewal: true,
            paymentMethod: "card",
            maskedPan: decodedData.payer_info?.pan_masked,
          });

          lokiService.logSubscriptionPurchase({
            userId: transaction.user_id,
            planId: subscriptionInfo.plan_id,
            priceId: 0,
            paymentType: "card",
            amount: Number(decodedData.amount) || transaction.amount,
            currency: "KZT",
            subscriptionId: subscription.id,
            transactionId: transaction.id,
            paymentId: String(decodedData.payment_id),
            success: true,
          });
        } catch (subscriptionError) {
          console.error("Error creating subscription:", subscriptionError);
        }
      }

      await updatePaymentTransaction(transaction.id, {
        orderId: decodedData.order_id,
        paymentId: String(decodedData.payment_id),
        status: "completed",
        transactionData: decodedData,
      });
    }

    return transaction;
  },

  async getHistory(
    userId: number,
    query: {
      page?: number;
      limit?: number;
      sortBy?: "created_at" | "expired_at" | "plan_name";
      sortOrder?: "asc" | "desc";
    }
  ) {
    return getUserSubscriptionHistory(userId, query);
  },

  async cancel(userId: number) {
    const activeSubscriptionInfo = await getActiveSubscriptionInfo(userId);

    if (!activeSubscriptionInfo.hasActiveSubscription || !activeSubscriptionInfo.expiresAt) {
      throw Object.assign(new Error("No active subscription found"), { statusCode: 404 });
    }

    const isCancelled = await cancelSubscription(userId);

    if (!isCancelled) {
      throw new Error("Failed to cancel subscription");
    }

    const updatedSubscriptionInfo = await getActiveSubscriptionInfo(userId);

    const expirationDate = new Date(activeSubscriptionInfo.expiresAt);
    const formattedDate = expirationDate.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    lokiService.logSubscriptionCancellation({
      userId,
      subscriptionId: 0,
      planName: activeSubscriptionInfo.subscriptionPlan || "Unknown",
      expiresAt: formattedDate,
      cancelledAt: updatedSubscriptionInfo.cancelledAt?.toString() || new Date().toISOString(),
    });

    return {
      formattedDate,
      plan_name: activeSubscriptionInfo.subscriptionPlan,
      expires_at: formattedDate,
      cancelled_at: updatedSubscriptionInfo.cancelledAt,
    };
  },

  async updateAutoRenewal(userId: number, enabled: boolean) {
    const activeSubscription = await db("user_subscriptions")
      .where("user_id", userId)
      .where("expired_at", ">", db.fn.now())
      .first();

    if (!activeSubscription) {
      throw Object.assign(new Error("No active subscription found"), { statusCode: 404 });
    }

    await db("user_subscriptions").where("id", activeSubscription.id).update({ is_auto_renewal: enabled });

    return { subscription_id: activeSubscription.id, is_auto_renewal: enabled };
  },
};
