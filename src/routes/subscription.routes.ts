import { Router, Request } from "express";

import { db } from "../db";
import { authMiddleware } from "../middleware/authMiddleware";
import {
  createPaymentTransaction,
  getTransactionById,
  getTransactionByOrderId,
  updatePaymentTransaction,
} from "../models/payment.model";
import {
  getAllSubscriptionPlansWithPrices,
  createSubscription,
  getSubscriptionPlanPrice,
  deleteSubscription,
  cancelSubscription,
  getSubscriptionInfoByTransactionId,
  getActiveSubscriptionInfo,
  getUserSubscriptionHistory,
} from "../models/subscription.model";
import { createToken, getPaymentTokenById } from "../models/token.model";
import { checkUserBalance, deductUserWalletForSubscription } from "../models/wallet.model";
import { lokiService } from "../utils/lokiService";
import { ERROR_CODES } from "../utils/errorCodes";
import { mapPaymentStatus } from "../utils/statusMapper";
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
} from "../utils/subscription";

interface CreateSubscriptionCreateBody {
  email: string;
  payment_type: "wallet" | "token" | "card";
  plan_id: number;
  price_id: number;
  token_id?: number; // Required when payment_type is "token"
  success_url?: string; // Optional custom redirect URL after successful payment
  failure_url?: string; // Optional custom redirect URL after failed payment
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

router.get("/", async (req: Request, res) => {
  try {
    const subscriptionPlans = await getAllSubscriptionPlansWithPrices();

    res.status(200).json({
      success: true,
      data: subscriptionPlans,
    });
  } catch (error) {
    console.error("Error fetching subscription plans:", (error as Error).message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch subscription plans",
      error: (error as Error).message,
    });
  }
});

router.get("/info", authMiddleware, async (req: Request, res) => {
  const userId = req.auth?.userId;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  try {
    const activeSubscriptionInfo = await getActiveSubscriptionInfo(userId);

    res.status(200).json({
      success: true,
      data: activeSubscriptionInfo,
    });
  } catch (error) {
    console.error("Error fetching subscription info:", (error as Error).message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch subscription info",
      error: (error as Error).message,
    });
  }
});

router.post("/create", authMiddleware, async (req: Request, res) => {
  const userId = req.auth?.userId;
  const { email, payment_type, plan_id, price_id, token_id, success_url, failure_url } =
    req.body as CreateSubscriptionCreateBody;

  console.log("=== SUBSCRIPTION CREATE REQUEST START ===");
  console.log("User ID:", userId);
  console.log("Request body:", JSON.stringify(req.body, null, 2));
  console.log("Request headers:", JSON.stringify(req.headers, null, 2));
  console.log("Extracted params:", {
    email,
    payment_type,
    plan_id,
    price_id,
    token_id,
  });

  if (!userId) {
    console.log("User ID not found in auth middleware");
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  try {
    // Валидация входных данных
    if (!payment_type || !plan_id || !price_id) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "Missing required fields: payment_type, plan_id, price_id",
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

    // Получение информации о плане и цене
    const planPrice = await getSubscriptionPlanPrice(plan_id, price_id);
    if (!planPrice) {
      return res.status(404).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "Subscription plan or price not found",
        },
      });
    }

    const amount = parseFloat(planPrice.price);

    const transactionId = await createPaymentTransaction({
      userId,
      currencyId: planPrice.currency_id,
      amount,
      type: "subscription",
      source: payment_type === "wallet" ? "wallet" : "card", // token и card оба используют "card" source
      status: "pending",
      subscriptionPlanId: plan_id,
      subscriptionPriceId: price_id,
    });

    // Разная логика в зависимости от типа оплаты
    switch (payment_type) {
      case "wallet": {
        // Проверяем баланс пользователя
        const balanceCheck = await checkUserBalance(userId, planPrice.currency_id, amount);

        if (!balanceCheck.hasEnoughBalance) {
          return res.status(400).json({
            error: {
              code: ERROR_CODES.SERVER_ERROR,
              message: `Insufficient balance. Current balance: ${balanceCheck.currentBalance} ${planPrice.currency_code}, Required: ${amount} ${planPrice.currency_code}`,
            },
          });
        }

        // План подписки определяется автоматически в createSubscription

        // Создаем подписку сначала, чтобы получить её ID
        const subscription = await createSubscription({
          userId,
          subscriptionPlanId: plan_id,
          isAutoRenewal: true,
          paymentMethod: "wallet",
        });

        // Списываем средства с кошелька и создаем транзакцию
        const deductionResult = await deductUserWalletForSubscription(
          userId,
          planPrice.currency_id,
          amount,
          subscription.id
        );

        if (!deductionResult.success) {
          // Если списание не удалось, удаляем созданную подписку
          await deleteSubscription(subscription.id);
          return res.status(500).json({
            error: {
              code: ERROR_CODES.SERVER_ERROR,
              message: `Failed to deduct balance: ${deductionResult.error}`,
            },
          });
        }

        // Обновляем транзакцию с ID подписки
        await updatePaymentTransaction(transactionId, {
          userSubscriptionId: subscription.id,
          status: "completed",
        });

        // Логируем успешную покупку подписки через кошелек
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

        const walletResponseData = {
          success: true,
          message: "Wallet payment completed successfully",
          payment_type: "wallet",
          data: {
            subscription_id: subscription.id,
            transaction_id: deductionResult.transactionId,
            amount_deducted: amount,
            currency: planPrice.currency_code,
            remaining_balance: (balanceCheck.currentBalance - amount).toString(),
          },
        };
        console.log("Wallet payment response:", JSON.stringify(walletResponseData, null, 2));
        console.log("=== SUBSCRIPTION CREATE REQUEST END ===");

        return res.status(200).json(walletResponseData);
      }

      case "token": {
        console.log("=== TOKEN PAYMENT DEBUG START ===");
        console.log("Token ID:", token_id);
        console.log("User ID:", userId);
        console.log("Plan ID:", plan_id);
        console.log("Price ID:", price_id);
        console.log("Amount:", amount);

        // Получение токена из базы данных
        const paymentToken = await getPaymentTokenById(token_id!, userId);
        console.log("Payment token from DB:", paymentToken);

        if (!paymentToken) {
          console.log("Payment token not found in DB");
          return res.status(404).json({
            error: {
              code: ERROR_CODES.SERVER_ERROR,
              message: "Payment token not found or doesn't belong to user",
            },
          });
        }

        // Проверка окружения для токеном оплаты
        if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
          console.log("Missing payment config environment variables");
          throw new Error("Missing required environment variables");
        }

        console.log("Payment config:", {
          hasSecretKey: !!paymentConfig.secretKey,
          hasApiKey: !!paymentConfig.apiKey,
          hasApiUrl: !!paymentConfig.apiUrl,
          apiUrl: paymentConfig.apiUrl,
        });

        const requestBodyToken = createPaymentRecurrentRequestBody(
          paymentToken.token,
          amount,
          paymentConfig
        );
        console.log("Request body for token payment:", JSON.stringify(requestBodyToken, null, 2));

        try {
          const responseToken = await sendPaymentRecurrentRequest(paymentConfig, requestBodyToken);
          console.log("Raw response from payment gateway:", {
            status: responseToken.status,
            statusText: responseToken.statusText,
            headers: responseToken.headers,
            data: responseToken.data,
          });

          const {
            data: dataToken,
            payment_id: paymentIdToken,
            sign: signToken,
            success: successToken,
          } = responseToken.data;

          console.log("Extracted response fields:", {
            hasData: !!dataToken,
            hasPaymentId: !!paymentIdToken,
            hasSign: !!signToken,
            success: successToken,
            paymentId: paymentIdToken,
          });

          if (typeof successToken === "undefined" || !dataToken || !paymentIdToken || !signToken) {
            console.log("Invalid API response: missing required fields");
            console.log("Response data structure:", responseToken.data);
            throw new Error("Invalid API response: missing required fields");
          }

          console.log("Verifying signature...");
          verifyResponseSignature(dataToken, signToken, paymentConfig.secretKey);
          console.log("Signature verification successful");

          const decodedDataToken: DecodedPaymentData = JSON.parse(
            Buffer.from(dataToken, "base64").toString("utf-8")
          );
          console.log("Decoded payment data:", JSON.stringify(decodedDataToken, null, 2));

          // Если оплата успешна, создаем подписку
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

          if (isPaymentSuccessful) {
            console.log("Payment successful, creating subscription...");

            try {
              const subscription = await createSubscription({
                userId,
                subscriptionPlanId: plan_id,
                isAutoRenewal: true, // Автопродление включено по умолчанию для токенных платежей
                paymentMethod: "card",
                maskedPan: paymentToken.pan_masked,
              });
              console.log("Subscription created successfully:", subscription.id);

              // Обновляем транзакцию с ID подписки и статусом completed
              await updatePaymentTransaction(transactionId, {
                orderId: decodedDataToken.order_id,
                paymentId: paymentIdToken,
                status: "completed",
                transactionData: decodedDataToken,
                userSubscriptionId: subscription.id,
              });
              console.log("Payment transaction updated with subscription ID");

              // Логируем успешную покупку подписки через токен
              lokiService.logSubscriptionPurchase({
                userId,
                planId: plan_id,
                priceId: price_id,
                paymentType: "token",
                amount,
                currency: "KZT", // TODO: получить валюту из decodedDataToken
                subscriptionId: subscription.id,
                transactionId,
                paymentId: paymentIdToken,
                success: true,
              });

              const responseData = {
                message: "Token payment was successful and subscription created",
                payment_id: paymentIdToken,
                data: decodedDataToken,
                sign: signToken,
                payment_type: "token",
                subscription_id: subscription.id,
              };
              console.log("Final response data:", JSON.stringify(responseData, null, 2));
              console.log("=== TOKEN PAYMENT DEBUG END ===");

              return res.status(200).json(responseData);
            } catch (subscriptionError) {
              console.error("Error creating subscription:", subscriptionError);

              // Обновляем транзакцию без подписки
              await updatePaymentTransaction(transactionId, {
                orderId: decodedDataToken.order_id,
                paymentId: paymentIdToken,
                status: mapPaymentStatus(decodedDataToken.payment_status),
                transactionData: decodedDataToken,
              });

              return res.status(500).json({
                error: {
                  code: ERROR_CODES.SERVER_ERROR,
                  message: "Payment successful but failed to create subscription",
                  details: (subscriptionError as Error).message,
                },
              });
            }
          } else {
            console.log("Payment failed or not successful");

            // Логируем неудачную покупку подписки через токен
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

            // Обновляем транзакцию
            await updatePaymentTransaction(transactionId, {
              orderId: decodedDataToken.order_id,
              paymentId: paymentIdToken,
              status: mapPaymentStatus(decodedDataToken.payment_status),
              transactionData: decodedDataToken,
            });
            console.log("Payment transaction updated successfully");

            const responseData = {
              message: "Token payment failed",
              payment_id: paymentIdToken,
              data: decodedDataToken,
              sign: signToken,
              payment_type: "token",
            };
            console.log("Final response data:", JSON.stringify(responseData, null, 2));
            console.log("=== TOKEN PAYMENT DEBUG END ===");

            return res.status(400).json(responseData);
          }
        } catch (paymentError) {
          console.log("=== TOKEN PAYMENT ERROR ===");
          console.error("Payment gateway error:", paymentError);
          console.log("Error details:", {
            message: (paymentError as Error).message,
            stack: (paymentError as Error).stack,
          });
          console.log("=== TOKEN PAYMENT ERROR END ===");
          throw paymentError;
        }
      }

      case "card": {
        // Проверка окружения для карточной оплаты
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

        // Формирование и отправка запроса для новой карты
        const requestBody = createSubscriptionRequestBody(
          amount,
          email,
          transactionId,
          paymentConfig,
          { success_url, failure_url }
        );
        const response = await sendPaymentCreateRequest(paymentConfig, requestBody);

        // Обработка ответа
        const { data, payment_id, sign, success } = response.data;

        if (typeof success === "undefined" || !data || !payment_id || !sign) {
          throw new Error("Invalid API response: missing required fields");
        }

        verifyResponseSignature(data, sign, paymentConfig.secretKey);

        const decodedData: DecodedPaymentData = JSON.parse(
          Buffer.from(data, "base64").toString("utf-8")
        );

        // Сохранение транзакции
        await updatePaymentTransaction(transactionId, {
          orderId: decodedData.order_id,
          paymentId: payment_id,
          status: mapPaymentStatus(decodedData.payment_status),
          transactionData: decodedData,
        });

        // Логируем покупку подписки через карту (первичный запрос)
        lokiService.logSubscriptionPurchase({
          userId,
          planId: plan_id,
          priceId: price_id,
          paymentType: "card",
          amount,
          currency: planPrice.currency_code,
          transactionId,
          paymentId: payment_id,
          success: success,
          error: success ? undefined : `Payment status: ${decodedData.payment_status}`,
        });

        const cardResponseData = {
          message: success ? "Payment was successful" : "Payment failed",
          payment_id,
          data: decodedData,
          sign,
          payment_type: "card",
        };
        console.log("Card payment response:", JSON.stringify(cardResponseData, null, 2));
        console.log("=== SUBSCRIPTION CREATE REQUEST END ===");

        return res.status(success ? 200 : 400).json(cardResponseData);
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
    console.log("=== SUBSCRIPTION CREATE ERROR ===");
    console.error("Ошибка создания платежа:", (error as Error).message, {
      email,
      payment_type,
      plan_id,
      price_id,
      token_id,
    });
    console.log("Error stack:", (error as Error).stack);
    console.log("=== SUBSCRIPTION CREATE REQUEST END ===");
    res.status(500).json({ message: "Ошибка оплаты", error: (error as Error).message });
  }
});

type StatusPaymentBody = {
  transactionId: string;
};

router.post("/status", authMiddleware, async (req: Request, res) => {
  const { transactionId } = req.body as StatusPaymentBody;

  try {
    // Проверка окружения
    if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
      throw new Error("Missing required environment variables");
    }

    // Валидация входных данных
    if (!transactionId) {
      throw new Error("Missing required fields: transactionId");
    }

    const transaction = await getTransactionById(Number(transactionId));

    if (!transaction || !transaction.order_id) {
      throw new Error("Transaction not found");
    }

    // Формирование и отправка запроса
    const requestBody = createPaymentStatusRequestBody(transaction.order_id, paymentConfig);
    const response = await sendPaymentStatusRequest(paymentConfig, requestBody);

    // Обработка ответа
    const { data, sign, success } = response.data;

    if (typeof success === "undefined" || !data || !sign) {
      throw new Error("Invalid API response: missing required fields");
    }

    verifyResponseSignature(data, sign, paymentConfig.secretKey);

    const decodedData: DecodedPaymentData = JSON.parse(
      Buffer.from(data, "base64").toString("utf-8")
    );

    // Формирование ответа
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

router.post("/recurrent", authMiddleware, async (req: Request, res) => {
  const { amount, token } = req.body;

  try {
    const userId = req.auth?.userId;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

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

    const decodedData: DecodedPaymentData = JSON.parse(
      Buffer.from(data, "base64").toString("utf-8")
    );

    //TODO: add logic to add recurrent payment to db

    const responsePayload = {
      message: success ? "Recurrent payment was successful" : "Recurrent payment failed",
      payment_id,
      data: decodedData,
      sign,
    };

    res.status(success ? 200 : 400).json(responsePayload);
  } catch (error) {
    console.error("Ошибка обработки рекуррентного платежа:", (error as Error).message);
    res.status(500).json({
      message: "Ошибка обработки рекуррентного платежа",
      error: (error as Error).message,
    });
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

  // console.log("decoded data", JSON.stringify(decodedData, null, 2));

  console.log("decodedData", decodedData);

  // Используем operation_status, если payment_status отсутствует
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

    // Get subscription plan info from transaction to determine duration
    console.log("getting subscription info for transaction", transaction.id);
    const subscriptionInfo = await getSubscriptionInfoByTransactionId(transaction.id);

    if (subscriptionInfo) {
      console.log(
        "creating subscription for user",
        transaction.user_id,
        "with plan",
        subscriptionInfo.plan_name
      );
      try {
        const subscription = await createSubscription({
          userId: transaction.user_id,
          subscriptionPlanId: subscriptionInfo.plan_id,
          isAutoRenewal: true, // Автопродление включено по умолчанию для карточных платежей
          paymentMethod: "card",
          maskedPan: decodedData.payer_info?.pan_masked,
        });
        console.log("subscription created:", subscription.id);

        // Логируем финальное подтверждение успешной покупки подписки
        if (subscriptionInfo) {
          lokiService.logSubscriptionPurchase({
            userId: transaction.user_id,
            planId: subscriptionInfo.plan_id,
            priceId: 0, // TODO: получить price_id из транзакции
            paymentType: "card",
            amount: Number(decodedData.amount) || transaction.amount,
            currency: "KZT",
            subscriptionId: subscription.id,
            transactionId: transaction.id,
            paymentId: String(decodedData.payment_id),
            success: true,
          });
        }
      } catch (subscriptionError) {
        console.error("Error creating subscription:", subscriptionError);
        // Continue processing even if subscription creation fails
      }
    }

    await updatePaymentTransaction(transaction.id, {
      orderId: decodedData.order_id,
      paymentId: String(decodedData.payment_id),
      status: decodedData.operation_status === "success" ? "completed" : "failed",
      transactionData: decodedData,
    });
  }

  try {
    return res.status(200).json(transaction);
  } catch (e) {
    console.error("Error responding:", e);
    return res.status(500).json({
      message: "Something went wrong",
      error: ERROR_CODES.SERVER_ERROR,
    });
  }
});

router.get("/history", authMiddleware, async (req: Request, res) => {
  const userId = req.auth?.userId;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  try {
    // Parse query parameters
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const sortBy = req.query.sortBy as "created_at" | "expired_at" | "plan_name" | undefined;
    const sortOrder = req.query.sortOrder as "asc" | "desc" | undefined;

    const result = await getUserSubscriptionHistory(userId, {
      page,
      limit,
      sortBy,
      sortOrder,
    });

    return res.status(200).json({
      success: true,
      message: "Subscription history retrieved successfully",
      data: {
        subscriptions: result.subscriptions,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          total_pages: result.totalPages,
        },
      },
    });
  } catch (error) {
    console.error("Error retrieving subscription history:", (error as Error).message);
    return res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to retrieve subscription history",
        details: (error as Error).message,
      },
    });
  }
});

router.delete("/cancel", authMiddleware, async (req: Request, res) => {
  const userId = req.auth?.userId;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  try {
    // Получаем информацию об активной подписке до отмены
    const activeSubscriptionInfo = await getActiveSubscriptionInfo(userId);

    if (!activeSubscriptionInfo.hasActiveSubscription || !activeSubscriptionInfo.expiresAt) {
      return res.status(404).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "No active subscription found",
        },
      });
    }

    // Отменяем подписку (отключаем автопродление, подписка остается активной до окончания текущего периода)
    const isCancelled = await cancelSubscription(userId);

    if (!isCancelled) {
      return res.status(500).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "Failed to cancel subscription",
        },
      });
    }

    // Получаем обновленную информацию о подписке с cancelled_at из базы данных
    const updatedSubscriptionInfo = await getActiveSubscriptionInfo(userId);

    // Форматируем дату окончания в формате DD.MM.YYYY
    const expirationDate = new Date(activeSubscriptionInfo.expiresAt);
    const formattedDate = expirationDate.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    // Логируем отмену подписки
    lokiService.logSubscriptionCancellation({
      userId,
      subscriptionId: 0, // TODO: получить ID подписки
      planName: activeSubscriptionInfo.subscriptionPlan || "Unknown",
      expiresAt: formattedDate,
      cancelledAt: updatedSubscriptionInfo.cancelledAt?.toString() || new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: `Your subscription ends on ${formattedDate}`,
      data: {
        plan_name: activeSubscriptionInfo.subscriptionPlan,
        expires_at: formattedDate,
        cancelled_at: updatedSubscriptionInfo.cancelledAt,
      },
    });
  } catch (error) {
    console.error("Error cancelling subscription:", (error as Error).message);
    return res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to cancel subscription",
        details: (error as Error).message,
      },
    });
  }
});

router.patch("/auto-renewal", authMiddleware, async (req: Request, res) => {
  const userId = req.auth?.userId;
  const { enabled } = req.body;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  if (typeof enabled !== "boolean") {
    return res.status(400).json({
      error: {
        code: ERROR_CODES.BAD_REQUEST,
        message: "Field 'enabled' must be a boolean",
      },
    });
  }

  try {
    // Получаем активную подписку
    const activeSubscription = await db("user_subscriptions")
      .where("user_id", userId)
      .where("expired_at", ">", db.fn.now())
      .first();

    if (!activeSubscription) {
      return res.status(404).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "No active subscription found",
        },
      });
    }

    // Обновляем настройку автопродления
    await db("user_subscriptions")
      .where("id", activeSubscription.id)
      .update({ is_auto_renewal: enabled });

    return res.status(200).json({
      success: true,
      message: `Auto-renewal ${enabled ? "enabled" : "disabled"} successfully`,
      data: {
        subscription_id: activeSubscription.id,
        is_auto_renewal: enabled,
      },
    });
  } catch (error) {
    console.error("Error updating auto-renewal setting:", (error as Error).message);
    return res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to update auto-renewal setting",
        details: (error as Error).message,
      },
    });
  }
});

export default router;
