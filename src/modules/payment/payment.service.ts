import { calculateFee } from "../../models/fee.model";
import {
  createPaymentTransaction,
  updatePaymentTransaction,
  hasUserPurchasedBar,
  getTransactionByOrderId,
  getTransactionById,
} from "../../models/payment.model";
import { getActiveSubscriptionInfo } from "../../models/subscription.model";
import { getPaymentTokenById, createToken } from "../../models/token.model";
import { checkUserBalance, deductUserWallet, depositUserWallet } from "../../models/wallet.model";
import { lokiService } from "../../utils/lokiService";
import { getBarById, getProfileById, getUserIdByProfileId } from "../../utils/mainServiceClient";
import { ERROR_CODES } from "../../utils/errorCodes";
import {
  createPaymentRequestBody,
  sendPaymentCreateRequest,
  verifyResponseSignature,
  DecodedPaymentData,
  createPaymentStatusRequestBody,
  sendPaymentStatusRequest,
} from "../../utils/payment";
import { mapPaymentStatus } from "../../utils/statusMapper";
import {
  createPaymentRecurrentRequestBody,
  sendPaymentRecurrentRequest,
  SubscriptionConfig,
  DecodedCallbackData,
} from "../../utils/subscription";
import { clearUserTransactionsCache } from "../wallet/wallet.service";

export interface CreatePaymentBody {
  email: string;
  payment_type: "wallet" | "token" | "card";
  currency_id?: number;
  token_id?: number;
  bar_id: string;
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

export const paymentService = {
  async createPayment(userId: number, body: CreatePaymentBody) {
    const { email, payment_type, currency_id = 1, token_id, bar_id, success_url, failure_url } = body;

    if (!payment_type || !email || !bar_id) {
      throw Object.assign(new Error("Missing required fields: payment_type, email, bar_id"), { statusCode: 400 });
    }

    const bar = await getBarById(bar_id);
    if (!bar) {
      throw Object.assign(new Error("Bar not found"), { statusCode: 404, code: ERROR_CODES.BARS_BAR_NOT_FOUND });
    }

    if (!bar.is_monetized) {
      throw Object.assign(new Error("Bar is not monetized and cannot be purchased"), { statusCode: 400 });
    }

    const ownerId = await getUserIdByProfileId(bar.profile_id as string);
    if (ownerId) {
      const subscriptionInfo = await getActiveSubscriptionInfo(ownerId);
      if (!subscriptionInfo.hasActiveSubscription) {
        throw Object.assign(
          new Error("This content is temporarily unavailable for purchase. Please contact the owner."),
          { statusCode: 403, code: ERROR_CODES.PAYMENT_OWNER_SUBSCRIPTION_INACTIVE }
        );
      }
    } else {
      throw Object.assign(
        new Error("This content is temporarily unavailable for purchase. Please contact the owner."),
        { statusCode: 403, code: ERROR_CODES.PAYMENT_OWNER_SUBSCRIPTION_INACTIVE }
      );
    }

    const monetizedDetails = bar.monetized_details as any;
    if (!monetizedDetails || !monetizedDetails.price || !monetizedDetails.currencyCode) {
      throw Object.assign(new Error("Bar monetization details are incomplete"), { statusCode: 400 });
    }

    const finalAmount = monetizedDetails.price;
    const finalCurrencyId = currency_id;

    const alreadyPurchased = await hasUserPurchasedBar(userId, bar_id);
    if (alreadyPurchased) {
      throw Object.assign(new Error("You have already purchased this bar"), { statusCode: 400 });
    }

    if (payment_type === "token" && !token_id) {
      throw Object.assign(new Error("token_id is required when payment_type is 'token'"), { statusCode: 400 });
    }

    let transactionId: number | null = null;

    if (payment_type !== "wallet") {
      transactionId = await createPaymentTransaction({
        userId,
        currencyId: finalCurrencyId,
        amount: finalAmount!,
        type: "withdraw",
        source: "card",
        status: "pending",
        barId: bar_id || null,
      });
    }

    switch (payment_type) {
      case "wallet": {
        const balanceCheck = await checkUserBalance(userId, finalCurrencyId, finalAmount!);

        if (!balanceCheck.hasEnoughBalance) {
          throw Object.assign(
            new Error(`Insufficient balance. Current balance: ${balanceCheck.currentBalance}, Required: ${finalAmount}`),
            { statusCode: 400 }
          );
        }

        const deductionResult = await deductUserWallet(userId, finalCurrencyId, finalAmount!, bar_id);

        if (!deductionResult.success) {
          throw new Error(`Failed to deduct balance: ${deductionResult.error}`);
        }

        try {
          const barOwnerProfile = await getProfileById(bar.profile_id as string);
          if (barOwnerProfile) {
            const feeCalculation = await calculateFee(finalAmount!, finalCurrencyId);
            const ownerAmount = feeCalculation.finalAmount;

            await depositUserWallet(barOwnerProfile.user_id, finalCurrencyId, ownerAmount);
            await createPaymentTransaction({
              userId: barOwnerProfile.user_id,
              currencyId: finalCurrencyId,
              amount: ownerAmount,
              type: "deposit",
              source: "wallet",
              status: "completed",
              barId: bar_id,
            });
            await clearUserTransactionsCache(barOwnerProfile.user_id);
          }
        } catch (error) {
          console.error(`Failed to credit bar owner for purchase ${bar_id}:`, error);
        }

        await clearUserTransactionsCache(userId);

        lokiService.logBarPurchase({
          userId,
          barId: bar_id,
          paymentType: "wallet",
          amount: finalAmount!,
          currency: monetizedDetails.currencyCode,
          transactionId: deductionResult.transactionId,
          success: true,
        });

        return {
          payment_type,
          data: {
            transaction_id: deductionResult.transactionId,
            amount_deducted: finalAmount,
            remaining_balance: (balanceCheck.currentBalance - finalAmount).toString(),
            bar_id,
            currency_code: monetizedDetails.currencyCode,
          },
        };
      }

      case "token": {
        if (!transactionId) throw new Error("Failed to create transaction");

        const paymentToken = await getPaymentTokenById(token_id!, userId);
        if (!paymentToken) {
          throw Object.assign(new Error("Payment token not found or doesn't belong to user"), { statusCode: 404 });
        }

        if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
          throw new Error("Missing required environment variables");
        }

        const requestBodyToken = createPaymentRecurrentRequestBody(paymentToken.token, finalAmount!, paymentConfig);
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

        await updatePaymentTransaction(transactionId, {
          orderId: decodedDataToken.order_id,
          paymentId: paymentIdToken,
          status: isPaymentSuccessful ? "completed" : mapPaymentStatus(decodedDataToken.payment_status),
          transactionData: decodedDataToken,
        });

        if (isPaymentSuccessful) {
          try {
            const barOwnerProfile = await getProfileById(bar.profile_id as string);
            if (barOwnerProfile) {
              const feeCalculation = await calculateFee(finalAmount!, finalCurrencyId);
              const ownerAmount = feeCalculation.finalAmount;

              await depositUserWallet(barOwnerProfile.user_id, finalCurrencyId, ownerAmount);
              await createPaymentTransaction({
                userId: barOwnerProfile.user_id,
                currencyId: finalCurrencyId,
                amount: ownerAmount,
                type: "deposit",
                source: "card",
                status: "completed",
                barId: bar_id,
                orderId: decodedDataToken.order_id,
                paymentId: paymentIdToken,
              });
              await clearUserTransactionsCache(barOwnerProfile.user_id);
            }
          } catch (error) {
            console.error(`Failed to credit bar owner for token purchase ${bar_id}:`, error);
          }

          await clearUserTransactionsCache(userId);
        }

        lokiService.logBarPurchase({
          userId,
          barId: bar_id,
          paymentType: "token",
          amount: finalAmount!,
          currency: monetizedDetails.currencyCode,
          transactionId,
          paymentId: paymentIdToken,
          success: isPaymentSuccessful,
          error: isPaymentSuccessful ? undefined : `Payment status: ${decodedDataToken.payment_status}`,
        });

        return {
          payment_type,
          isPaymentSuccessful,
          data: {
            payment_id: paymentIdToken,
            data: decodedDataToken,
            payment_type,
            bar_id,
            amount_paid: finalAmount,
            currency_code: monetizedDetails.currencyCode,
          },
        };
      }

      case "card": {
        if (!transactionId) throw new Error("Failed to create transaction");

        if (
          !paymentConfig.secretKey ||
          !paymentConfig.apiKey ||
          !paymentConfig.apiUrl ||
          !paymentConfig.kornerUrl ||
          !paymentConfig.merchantId ||
          !paymentConfig.serviceId
        ) {
          throw new Error("Missing required environment variables");
        }

        const requestBody = createPaymentRequestBody(
          finalAmount!,
          email,
          transactionId,
          paymentConfig,
          bar_id ? Number(bar_id) : undefined,
          { success_url, failure_url }
        );
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

        lokiService.logBarPurchase({
          userId,
          barId: bar_id,
          paymentType: "card",
          amount: finalAmount!,
          currency: monetizedDetails.currencyCode,
          transactionId,
          paymentId: payment_id,
          success,
          error: success ? undefined : `Payment status: ${decodedData.payment_status}`,
        });

        return {
          payment_type,
          isPaymentSuccessful: success,
          data: {
            payment_id,
            data: decodedData,
            payment_type,
            bar_id,
            amount_paid: finalAmount,
            currency_code: monetizedDetails.currencyCode,
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

    console.log("Payment callback received for bar purchase:", decodedData);

    if (decodedData.operation_status === "success") {
      console.log("Creating payment token for user:", transaction.user_id);

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

      await updatePaymentTransaction(transaction.id, {
        orderId: decodedData.order_id,
        paymentId: String(decodedData.payment_id),
        status: "completed",
        transactionData: decodedData,
      });

      if (transaction.bar_id && transaction.status !== "completed") {
        try {
          const bar = await getBarById(transaction.bar_id);
          if (bar) {
            const barOwnerProfile = await getProfileById(bar.profile_id as string);
            if (barOwnerProfile) {
              const feeCalculation = await calculateFee(transaction.amount, transaction.currency_id);
              const ownerAmount = feeCalculation.finalAmount;

              await depositUserWallet(barOwnerProfile.user_id, transaction.currency_id, ownerAmount);
              await createPaymentTransaction({
                userId: barOwnerProfile.user_id,
                currencyId: transaction.currency_id,
                amount: ownerAmount,
                type: "deposit",
                source: "card",
                status: "completed",
                barId: transaction.bar_id,
                orderId: decodedData.order_id,
                paymentId: String(decodedData.payment_id),
              });
              await clearUserTransactionsCache(barOwnerProfile.user_id);
            }
          }
        } catch (error) {
          console.error(`Failed to credit bar owner for card purchase ${transaction.bar_id}:`, error);
        }
      }

      await clearUserTransactionsCache(transaction.user_id);

      if (transaction.bar_id) {
        lokiService.logBarPurchase({
          userId: transaction.user_id,
          barId: transaction.bar_id,
          paymentType: "card",
          amount: transaction.amount,
          currency: "KZT",
          transactionId: transaction.id,
          paymentId: String(decodedData.payment_id),
          success: true,
        });
      }
    } else {
      await updatePaymentTransaction(transaction.id, {
        orderId: decodedData.order_id,
        paymentId: String(decodedData.payment_id),
        status: "failed",
        transactionData: decodedData,
      });

      if (transaction.bar_id) {
        lokiService.logBarPurchase({
          userId: transaction.user_id,
          barId: transaction.bar_id,
          paymentType: "card",
          amount: transaction.amount,
          currency: "KZT",
          transactionId: transaction.id,
          paymentId: String(decodedData.payment_id),
          success: false,
          error: `Operation status: ${decodedData.operation_status}`,
        });
      }
    }

    return transaction;
  },
};
