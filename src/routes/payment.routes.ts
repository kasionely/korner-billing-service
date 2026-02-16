import { Router, Request } from "express";

import { clearUserTransactionsCache } from "./wallet.routes";
import { authMiddleware } from "../middleware/authMiddleware";
import { calculateFee } from "../models/fee.model";
import {
  createPaymentTransaction,
  updatePaymentTransaction,
  hasUserPurchasedBar,
  getTransactionByOrderId,
  getTransactionById,
} from "../models/payment.model";
import { getActiveSubscriptionInfo } from "../models/subscription.model";
import { getPaymentTokenById, createToken } from "../models/token.model";
import { checkUserBalance, deductUserWallet, depositUserWallet } from "../models/wallet.model";
import { lokiService } from "../utils/lokiService";
import { getBarById, getProfileById, getUserIdByProfileId } from "../utils/mainServiceClient";
import { ERROR_CODES } from "../utils/errorCodes";
import {
  createPaymentRequestBody,
  sendPaymentCreateRequest,
  verifyResponseSignature,
  DecodedPaymentData,
  createPaymentStatusRequestBody,
  sendPaymentStatusRequest,
} from "../utils/payment";
import { mapPaymentStatus } from "../utils/statusMapper";
import {
  createPaymentRecurrentRequestBody,
  sendPaymentRecurrentRequest,
  SubscriptionConfig,
  DecodedCallbackData,
} from "../utils/subscription";

interface AuthRequest extends Request {
  auth?: { userId: number };
}

interface CreatePaymentBody {
  email: string;
  payment_type: "wallet" | "token" | "card";
  currency_id?: number;
  token_id?: number;
  bar_id: string;
  success_url?: string;
  failure_url?: string;
}

const router = Router();

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

router.post("/create", authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  const {
    email,
    payment_type,
    currency_id = 1,
    token_id,
    bar_id,
    success_url,
    failure_url,
  } = req.body as CreatePaymentBody;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  let transactionId: number | null = null;

  try {
    if (!payment_type || !email || !bar_id) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Missing required fields: payment_type, email, bar_id",
        },
      });
    }

    const bar = await getBarById(bar_id);
    if (!bar) {
      return res.status(404).json({
        error: {
          code: ERROR_CODES.BARS_BAR_NOT_FOUND,
          message: "Bar not found",
        },
      });
    }

    if (!bar.is_monetized) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Bar is not monetized and cannot be purchased",
        },
      });
    }

    const ownerId = await getUserIdByProfileId(bar.profile_id as string);
    if (ownerId) {
      const subscriptionInfo = await getActiveSubscriptionInfo(ownerId);
      if (!subscriptionInfo.hasActiveSubscription) {
        return res.status(403).json({
          error: {
            code: ERROR_CODES.PAYMENT_OWNER_SUBSCRIPTION_INACTIVE,
            message:
              "This content is temporarily unavailable for purchase. Please contact the owner.",
          },
        });
      }
    } else {
      return res.status(403).json({
        error: {
          code: ERROR_CODES.PAYMENT_OWNER_SUBSCRIPTION_INACTIVE,
          message:
            "This content is temporarily unavailable for purchase. Please contact the owner.",
        },
      });
    }

    const monetizedDetails = bar.monetized_details as any;
    if (!monetizedDetails || !monetizedDetails.price || !monetizedDetails.currencyCode) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Bar monetization details are incomplete",
        },
      });
    }

    const finalAmount = monetizedDetails.price;
    const finalCurrencyId = currency_id;

    const alreadyPurchased = await hasUserPurchasedBar(userId, bar_id);
    if (alreadyPurchased) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "You have already purchased this bar",
        },
      });
    }

    if (payment_type === "token" && !token_id) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "token_id is required when payment_type is 'token'",
        },
      });
    }

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
          return res.status(400).json({
            error: {
              code: ERROR_CODES.BAD_REQUEST,
              message: `Insufficient balance. Current balance: ${balanceCheck.currentBalance}, Required: ${finalAmount}`,
            },
          });
        }

        const deductionResult = await deductUserWallet(
          userId,
          finalCurrencyId,
          finalAmount!,
          bar_id
        );

        if (!deductionResult.success) {
          return res.status(500).json({
            error: {
              code: ERROR_CODES.SERVER_ERROR,
              message: `Failed to deduct balance: ${deductionResult.error}`,
            },
          });
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

            console.log(
              `Successfully credited ${ownerAmount} to bar owner (user ${barOwnerProfile.user_id}), fee: ${feeCalculation.feeAmount} (${feeCalculation.feePercentage}%)`
            );
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

        const responseData = {
          transaction_id: deductionResult.transactionId,
          amount_deducted: finalAmount,
          remaining_balance: (balanceCheck.currentBalance - finalAmount).toString(),
          bar_id,
          currency_code: monetizedDetails.currencyCode,
        };

        return res.status(200).json({
          success: true,
          message: "Bar purchased successfully",
          data: responseData,
          payment_type,
        });
      }

      case "token": {
        if (!transactionId) {
          return res.status(500).json({
            error: {
              code: ERROR_CODES.SERVER_ERROR,
              message: "Failed to create transaction",
            },
          });
        }

        const paymentToken = await getPaymentTokenById(token_id!, userId);
        if (!paymentToken) {
          return res.status(404).json({
            error: {
              code: ERROR_CODES.SERVER_ERROR,
              message: "Payment token not found or doesn't belong to user",
            },
          });
        }

        if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
          throw new Error("Missing required environment variables");
        }

        const requestBodyToken = createPaymentRecurrentRequestBody(
          paymentToken.token,
          finalAmount!,
          paymentConfig
        );
        const responseToken = await sendPaymentRecurrentRequest(paymentConfig, requestBodyToken);

        const {
          data: dataToken,
          payment_id: paymentIdToken,
          sign: signToken,
          success: successToken,
        } = responseToken.data;

        if (typeof successToken === "undefined" || !dataToken || !paymentIdToken || !signToken) {
          throw new Error("Invalid API response: missing required fields");
        }

        verifyResponseSignature(dataToken, signToken, paymentConfig.secretKey);

        const decodedDataToken: DecodedPaymentData = JSON.parse(
          Buffer.from(dataToken, "base64").toString("utf-8")
        );

        console.log("=== TOKEN PAYMENT DEBUG (payment/create) ===");
        console.log("Decoded payment data:", JSON.stringify(decodedDataToken, null, 2));

        const isPaymentSuccessful =
          successToken &&
          (decodedDataToken.payment_status === "success" ||
            decodedDataToken.payment_status === "withdraw" ||
            decodedDataToken.operation_status === "success");

        console.log("Payment success check:", {
          successToken,
          payment_status: decodedDataToken.payment_status,
          operation_status: decodedDataToken.operation_status,
          isPaymentSuccessful,
        });

        await updatePaymentTransaction(transactionId, {
          orderId: decodedDataToken.order_id,
          paymentId: paymentIdToken,
          status: isPaymentSuccessful
            ? "completed"
            : mapPaymentStatus(decodedDataToken.payment_status),
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

              console.log(
                `Successfully credited ${ownerAmount} to bar owner (user ${barOwnerProfile.user_id}) for token purchase, fee: ${feeCalculation.feeAmount} (${feeCalculation.feePercentage}%)`
              );
            }
          } catch (error) {
            console.error(`Failed to credit bar owner for token purchase ${bar_id}:`, error);
          }

          await clearUserTransactionsCache(userId);
        }

        const tokenResponseData = {
          payment_id: paymentIdToken,
          data: decodedDataToken,
          payment_type,
          bar_id,
          amount_paid: finalAmount,
          currency_code: monetizedDetails.currencyCode,
        };

        lokiService.logBarPurchase({
          userId,
          barId: bar_id,
          paymentType: "token",
          amount: finalAmount!,
          currency: monetizedDetails.currencyCode,
          transactionId,
          paymentId: paymentIdToken,
          success: isPaymentSuccessful,
          error: isPaymentSuccessful
            ? undefined
            : `Payment status: ${decodedDataToken.payment_status}`,
        });

        console.log("=== TOKEN PAYMENT DEBUG END ===");

        return res.status(isPaymentSuccessful ? 200 : 400).json({
          success: isPaymentSuccessful,
          message: isPaymentSuccessful ? "Bar purchased successfully" : "Bar purchase failed",
          ...tokenResponseData,
        });
      }

      case "card": {
        if (!transactionId) {
          return res.status(500).json({
            error: {
              code: ERROR_CODES.SERVER_ERROR,
              message: "Failed to create transaction",
            },
          });
        }

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

        const decodedData: DecodedPaymentData = JSON.parse(
          Buffer.from(data, "base64").toString("utf-8")
        );

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
          success: success,
          error: success ? undefined : `Payment status: ${decodedData.payment_status}`,
        });

        const cardResponseData = {
          payment_id,
          data: decodedData,
          payment_type,
          bar_id,
          amount_paid: finalAmount,
          currency_code: monetizedDetails.currencyCode,
        };

        return res.status(success ? 200 : 400).json({
          success: success,
          message: success ? "Bar purchased successfully" : "Bar purchase failed",
          ...cardResponseData,
        });
      }

      default: {
        return res.status(400).json({
          error: {
            code: ERROR_CODES.SERVER_ERROR,
            message: "Invalid payment_type. Must be 'wallet', 'token', or 'card'",
          },
        });
      }
    }
  } catch (error) {
    console.error("Ошибка создания платежа:", (error as Error).message, {
      bar_id,
      email,
      payment_type,
      currency_id,
      token_id,
    });

    lokiService.logPaymentError({
      userId,
      paymentType: payment_type as "wallet" | "token" | "card",
      transactionId: transactionId || undefined,
      error: (error as Error).message,
      details: { bar_id, email, payment_type, currency_id, token_id },
    });

    res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to purchase bar",
        details: (error as Error).message,
      },
    });
  }
});

type StatusPaymentBody = {
  transactionId: string;
};

router.post("/status", authMiddleware, async (req: AuthRequest, res) => {
  const { transactionId } = req.body as StatusPaymentBody;

  try {
    if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
      throw new Error("Missing required environment variables");
    }

    if (!transactionId) {
      throw new Error("Missing required fields: transactionId");
    }

    const transaction = await getTransactionById(Number(transactionId));

    if (!transaction || !transaction.order_id) {
      throw new Error("Transaction not found");
    }

    const requestBody = createPaymentStatusRequestBody(transaction.order_id, paymentConfig);
    const response = await sendPaymentStatusRequest(paymentConfig, requestBody);

    const { data, sign, success } = response.data;

    if (typeof success === "undefined" || !data || !sign) {
      throw new Error("Invalid API response: missing required fields");
    }

    verifyResponseSignature(data, sign, paymentConfig.secretKey);

    const decodedData: DecodedPaymentData = JSON.parse(
      Buffer.from(data, "base64").toString("utf-8")
    );

    const responsePayload = {
      message: success ? "Status retrieved successfully" : "Failed to retrieve status",
      data: decodedData,
      sign,
    };

    res.status(success ? 200 : 400).json(responsePayload);
  } catch (error) {
    console.error("Ошибка получения статуса платежа:", (error as Error).message, {
      transactionId,
    });
    res.status(500).json({ message: "Ошибка получения статуса", error: (error as Error).message });
  }
});

router.post("/callback", async (req: Request, res) => {
  const { data, sign } = req.body;

  if (!data || !sign) {
    return res.status(400).json({
      message: "Invalid API response: missing required fields",
      error: ERROR_CODES.SERVER_ERROR,
    });
  }

  let decodedData: DecodedCallbackData;
  try {
    const decodedString = Buffer.from(data, "base64").toString("utf-8");
    decodedData = JSON.parse(decodedString);
  } catch (error) {
    console.error("Error decoding or parsing data:", error);
    return res.status(400).json({
      message: "Invalid data format",
      error: ERROR_CODES.SERVER_ERROR,
    });
  }

  try {
    verifyResponseSignature(data, sign, paymentConfig.secretKey);
  } catch (error) {
    console.error("Signature verification failed:", error);
    return res.status(400).json({
      message: "Invalid signature",
      error: ERROR_CODES.SERVER_ERROR,
    });
  }

  const transaction = await getTransactionByOrderId(decodedData.order_id);

  if (!transaction) {
    return res.status(404).json({
      message: "Transaction not found",
      error: ERROR_CODES.SERVER_ERROR,
    });
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

    console.log("Bar purchase confirmed for transaction:", transaction.id);

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

            console.log(
              `Successfully credited ${ownerAmount} to bar owner (user ${barOwnerProfile.user_id}) for card purchase via callback, fee: ${feeCalculation.feeAmount} (${feeCalculation.feePercentage}%)`
            );
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

    console.log("Bar purchase completed successfully");
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

    console.log("Bar purchase failed for transaction:", transaction.id);
  }

  try {
    return res.status(200).json({
      success: true,
      message: "Callback processed successfully",
      transaction_id: transaction.id,
    });
  } catch (e) {
    console.error("Error responding to callback:", e);
    return res.status(500).json({
      message: "Something went wrong",
      error: ERROR_CODES.SERVER_ERROR,
    });
  }
});

export default router;
