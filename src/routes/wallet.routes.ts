import { Router, Request, Response } from "express";

import { authMiddleware } from "../middleware/authMiddleware";
import { createPaymentTransaction, updatePaymentTransaction } from "../models/payment.model";
import { getTransactionByOrderId } from "../models/payment.model";
import { getPaymentTokenById, createToken } from "../models/token.model";
import {
  getUserBalances,
  getUserBalanceByCurrency,
  getUserTransactionHistory,
  createUserWallet,
  depositUserWallet,
} from "../models/wallet.model";
import { ERROR_CODES } from "../utils/errorCodes";
import { sendPaymentReceiptRequest } from "../utils/payment";
import redis from "../utils/redis";
import { uploadToBothBuckets } from "../utils/s3.utils";
import { mapPaymentStatus } from "../utils/statusMapper";
import {
  verifyResponseSignature,
  DecodedPaymentData,
  sendPaymentCreateRequest,
  createPaymentRecurrentRequestBody,
  sendPaymentRecurrentRequest,
  SubscriptionConfig,
} from "../utils/subscription";
import { DecodedCallbackData } from "../utils/subscription";
import { createDepositPaymentRequest } from "../utils/wallet";

interface TopUpBody {
  amount: number;
  email: string;
  paymentType: "card" | "token";
  currencyId?: number;
  tokenId?: number;
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

router.get("/balance", authMiddleware, async (req: Request, res: Response) => {
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
    const balances = await getUserBalances(userId);

    res.status(200).json({
      success: true,
      data: balances,
    });
  } catch (error) {
    console.error("Error fetching user balances:", (error as Error).message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch balances",
      error: (error as Error).message,
    });
  }
});

router.get("/balance/:currencyId", authMiddleware, async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  const { currencyId } = req.params;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  if (!currencyId || isNaN(Number(currencyId))) {
    return res.status(400).json({
      success: false,
      message: "Invalid currency ID",
    });
  }

  try {
    const balance = await getUserBalanceByCurrency(userId, Number(currencyId));

    if (!balance) {
      return res.status(404).json({
        success: false,
        message: "Balance not found for this currency",
      });
    }

    res.status(200).json({
      success: true,
      data: balance,
    });
  } catch (error) {
    console.error("Error fetching user balance by currency:", (error as Error).message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch balance",
      error: (error as Error).message,
    });
  }
});

router.get("/transactions", authMiddleware, async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  const cacheKey = `user_transactions:${userId}:${limit}:${offset}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }
  } catch (error) {
    console.warn("Redis cache read error:", error);
  }

  try {
    const transactions = await getUserTransactionHistory(userId, limit, offset);

    const response = {
      success: true,
      data: transactions,
      pagination: {
        limit,
        offset,
        count: transactions.length,
      },
    };

    try {
      await redis.setex(cacheKey, 3600, JSON.stringify(response));
    } catch (error) {
      console.warn("Redis cache write error:", error);
    }

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching transaction history:", (error as Error).message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch transaction history",
      error: (error as Error).message,
    });
  }
});

router.post("/create", authMiddleware, async (req: Request, res: Response) => {
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
    await createUserWallet(userId);

    res.status(201).json({
      success: true,
      message: "Wallet created successfully",
    });
  } catch (error) {
    console.error("Error creating wallet:", (error as Error).message);
    res.status(500).json({
      success: false,
      message: "Failed to create wallet",
      error: (error as Error).message,
    });
  }
});

router.post("/top-up", authMiddleware, async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  const { amount, email, paymentType, currencyId = 1, tokenId } = req.body as TopUpBody;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  try {
    // Валидация входных данных
    if (!paymentType || !amount || !email) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "Missing required fields: paymentType, amount, email",
        },
      });
    }

    if (paymentType === "token" && !tokenId) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "tokenId is required when paymentType is 'token'",
        },
      });
    }

    // Проверка окружения
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

    const transactionId = await createPaymentTransaction({
      userId,
      currencyId: currencyId,
      amount,
      type: "deposit",
      source: "card",
      status: "pending",
    });

    // Разная логика в зависимости от типа оплаты
    switch (paymentType) {
      case "token": {
        // Получение токена из базы данных
        const paymentToken = await getPaymentTokenById(tokenId!, userId);
        if (!paymentToken) {
          return res.status(404).json({
            error: {
              code: ERROR_CODES.SERVER_ERROR,
              message: "Payment token not found or doesn't belong to user",
            },
          });
        }

        const requestBodyToken = createPaymentRecurrentRequestBody(
          paymentToken.token,
          amount,
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

        console.log("Decoded payment data:", JSON.stringify(decodedDataToken, null, 2));

        // Проверяем успешность платежа включая статус "withdraw"
        const isPaymentSuccessful =
          successToken &&
          (decodedDataToken.payment_status === "success" ||
            decodedDataToken.payment_status === "withdraw" ||
            decodedDataToken.operation_status === "success");

        // Если платеж успешен, сразу пополняем кошелек
        if (isPaymentSuccessful) {
          try {
            await depositUserWallet(userId, currencyId, amount);
            await clearUserTransactionsCache(userId);
          } catch (depositError) {
            console.error("❌ ERROR depositing to wallet:", depositError);
            // Продолжаем обработку даже если пополнение не удалось
          }
        }

        // Обновляем транзакцию с правильным статусом
        await updatePaymentTransaction(transactionId, {
          orderId: decodedDataToken.order_id,
          paymentId: paymentIdToken,
          status: isPaymentSuccessful
            ? "completed"
            : mapPaymentStatus(decodedDataToken.payment_status),
          transactionData: decodedDataToken,
        });

        const responseData = {
          success: isPaymentSuccessful,
          message: isPaymentSuccessful
            ? "Token top-up payment was successful"
            : "Token top-up payment failed",
          payment_id: paymentIdToken,
          paymentType: "token",
          data: decodedDataToken,
          sign: signToken,
        };

        return res.status(isPaymentSuccessful ? 200 : 400).json(responseData);
      }

      case "card": {
        // Формирование и отправка запроса для новой карты
        const requestBody = createDepositPaymentRequest(
          amount,
          email,
          transactionId,
          paymentConfig
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

        console.log("decodedData card top-up", decodedData);

        // Сохранение транзакции
        await updatePaymentTransaction(transactionId, {
          orderId: decodedData.order_id,
          paymentId: payment_id,
          status: mapPaymentStatus(decodedData.payment_status),
          transactionData: decodedData,
        });

        return res.status(success ? 200 : 400).json({
          success: success,
          message: success ? "Card top-up payment was successful" : "Card top-up payment failed",
          paymentType: "card",
          payment_id,
          data: decodedData,
        });
      }

      default: {
        return res.status(400).json({
          error: {
            code: ERROR_CODES.SERVER_ERROR,
            message: "Invalid paymentType. Must be 'token' or 'card'",
          },
        });
      }
    }
  } catch (error) {
    console.error("Ошибка создания платежа для пополнения:", (error as Error).message, {
      amount,
      email,
      paymentType,
      currencyId,
      tokenId,
    });
    res.status(500).json({ message: "Ошибка оплаты", error: (error as Error).message });
  }
});

router.post("/callback", async (req: Request, res: Response) => {
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

  console.log("=== WALLET CALLBACK DEBUG ===");
  console.log("decodedData", JSON.stringify(decodedData, null, 2));
  console.log("transaction", JSON.stringify(transaction, null, 2));

  // Проверяем тип платежа по order_id
  const isRecurrentPayment = decodedData.order_id?.startsWith("recurrent_");
  console.log("Is recurrent payment:", isRecurrentPayment);
  console.log("Order ID:", decodedData.order_id);
  console.log("Operation status:", decodedData.operation_status);
  console.log("Transaction type:", transaction.type);
  console.log("Transaction status:", transaction.status);

  // Обрабатываем только успешные платежи типа "deposit"
  // НЕ пополняем баланс для токен-платежей (recurrent_*), так как они уже обработаны в /top-up
  if (
    decodedData.operation_status === "success" &&
    transaction.type === "deposit" &&
    !isRecurrentPayment
  ) {
    console.log("Processing wallet deposit for user", transaction.user_id);

    // Сохраняем токен для будущих платежей (только для карточных платежей)
    if (decodedData.recurrent_token) {
      try {
        await createToken({
          userId: transaction.user_id,
          token: decodedData.recurrent_token,
          expired_at: decodedData.payment_date,
          amount: decodedData.amount,
          pan_masked: decodedData.payer_info?.pan_masked,
        });
        console.log("Payment token saved for user:", transaction.user_id);
      } catch (tokenError) {
        console.error("Error saving payment token:", tokenError);
        // Continue processing even if token save fails
      }
    }

    try {
      // Пополняем баланс пользователя
      await depositUserWallet(transaction.user_id, transaction.currency_id, transaction.amount);
      console.log("Wallet deposit completed:", transaction.amount);
      await clearUserTransactionsCache(transaction.user_id);
    } catch (depositError) {
      console.error("Error depositing to wallet:", depositError);
      // Continue processing even if deposit fails
    }
  } else if (isRecurrentPayment) {
    console.log("SKIPPING wallet deposit for recurrent payment (already processed in /top-up)");
  } else {
    console.log("SKIPPING wallet deposit - conditions not met:", {
      operation_status: decodedData.operation_status,
      type: transaction.type,
      isRecurrent: isRecurrentPayment,
    });
  }

  console.log("=== WALLET CALLBACK DEBUG END ===");

  // НЕ перезаписываем payment_id - используем тот что уже сохранен в БД
  await updatePaymentTransaction(transaction.id, {
    orderId: decodedData.order_id,
    paymentId: transaction.payment_id,
    status: decodedData.operation_status === "success" ? "completed" : "failed",
    transactionData: decodedData,
  });

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

router.post("/get-receipt", authMiddleware, async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  const payment_id = req.body.payment_id as string;
  const order_id = req.body.order_id as string;

  if (!userId) {
    return res.status(401).json({
      error: {
        code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
        message: "Invalid user ID",
      },
    });
  }

  if (!payment_id || !order_id) {
    return res.status(400).json({
      success: false,
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Missing required parameters: payment_id and order_id",
      },
    });
  }

  try {
    // Проверка окружения
    if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
      throw new Error("Missing required environment variables");
    }

    // Проверка что транзакция принадлежит пользователю
    const transaction = await getTransactionByOrderId(order_id);
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    if (transaction.user_id != userId) {
      return res.status(403).json({
        success: false,
        message: "Access denied: this transaction does not belong to you",
      });
    }

    const response = await sendPaymentReceiptRequest(paymentConfig, payment_id, order_id);

    const pdfBuffer = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(response.data as any);

    const filename = `${order_id}_${payment_id}.pdf`;
    const receiptUrl = await uploadToBothBuckets(
      "receipts",
      pdfBuffer,
      filename,
      "application/pdf"
    );

    return res.json({
      success: true,
      url: receiptUrl,
      message: "Receipt URL generated successfully",
    });
  } catch (error: any) {
    console.error("Ошибка получения квитанции:", (error as Error).message);

    if (error.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: "Receipt not found",
      });
    }

    res.status(500).json({
      success: false,
      message: "Ошибка получения квитанции",
      error: (error as Error).message,
    });
  }
});

export const clearUserTransactionsCache = async (userId: number): Promise<void> => {
  try {
    const pattern = `user_transactions:${userId}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(keys);
    }
  } catch (error) {
    console.warn("Error clearing user transactions cache:", error);
  }
};

export default router;
