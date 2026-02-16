import { createPaymentTransaction, updatePaymentTransaction } from "../../models/payment.model";
import { getTransactionByOrderId } from "../../models/payment.model";
import { getPaymentTokenById, createToken } from "../../models/token.model";
import {
  getUserBalances,
  getUserBalanceByCurrency,
  getUserTransactionHistory,
  createUserWallet,
  depositUserWallet,
} from "../../models/wallet.model";
import { sendPaymentReceiptRequest } from "../../utils/payment";
import redis from "../../utils/redis";
import { uploadToBothBuckets } from "../../utils/s3.utils";
import { mapPaymentStatus } from "../../utils/statusMapper";
import {
  verifyResponseSignature,
  DecodedPaymentData,
  sendPaymentCreateRequest,
  createPaymentRecurrentRequestBody,
  sendPaymentRecurrentRequest,
  SubscriptionConfig,
  DecodedCallbackData,
} from "../../utils/subscription";
import { createDepositPaymentRequest } from "../../utils/wallet";

export interface TopUpBody {
  amount: number;
  email: string;
  paymentType: "card" | "token";
  currencyId?: number;
  tokenId?: number;
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

export const walletService = {
  async getBalance(userId: number) {
    return getUserBalances(userId);
  },

  async getBalanceByCurrency(userId: number, currencyId: number) {
    return getUserBalanceByCurrency(userId, currencyId);
  },

  async getTransactions(userId: number, limit: number, offset: number) {
    const cacheKey = `user_transactions:${userId}:${limit}:${offset}`;

    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) return { cached: true, data: JSON.parse(cached) };

    const transactions = await getUserTransactionHistory(userId, limit, offset);
    const response = {
      success: true,
      data: transactions,
      pagination: { limit, offset, count: transactions.length },
    };

    redis.setex(cacheKey, 3600, JSON.stringify(response)).catch(() => null);
    return { cached: false, data: response };
  },

  async createWallet(userId: number) {
    return createUserWallet(userId);
  },

  async topUp(userId: number, body: TopUpBody) {
    const { amount, email, paymentType, currencyId = 1, tokenId } = body;

    if (!paymentType || !amount || !email) {
      throw Object.assign(new Error("Missing required fields: paymentType, amount, email"), { statusCode: 400 });
    }

    if (paymentType === "token" && !tokenId) {
      throw Object.assign(new Error("tokenId is required when paymentType is 'token'"), { statusCode: 400 });
    }

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
      currencyId,
      amount,
      type: "deposit",
      source: "card",
      status: "pending",
    });

    if (paymentType === "token") {
      const paymentToken = await getPaymentTokenById(tokenId!, userId);
      if (!paymentToken) {
        throw Object.assign(new Error("Payment token not found or doesn't belong to user"), { statusCode: 404 });
      }

      const requestBodyToken = createPaymentRecurrentRequestBody(paymentToken.token, amount, paymentConfig);
      const responseToken = await sendPaymentRecurrentRequest(paymentConfig, requestBodyToken);

      const { data: dataToken, payment_id: paymentIdToken, sign: signToken, success: successToken } = responseToken.data;

      if (typeof successToken === "undefined" || !dataToken || !paymentIdToken || !signToken) {
        throw new Error("Invalid API response: missing required fields");
      }

      verifyResponseSignature(dataToken, signToken, paymentConfig.secretKey);

      const decodedDataToken: DecodedPaymentData = JSON.parse(Buffer.from(dataToken, "base64").toString("utf-8"));

      console.log("Decoded payment data:", JSON.stringify(decodedDataToken, null, 2));

      const isPaymentSuccessful =
        successToken &&
        (decodedDataToken.payment_status === "success" ||
          decodedDataToken.payment_status === "withdraw" ||
          decodedDataToken.operation_status === "success");

      if (isPaymentSuccessful) {
        try {
          await depositUserWallet(userId, currencyId, amount);
          await clearUserTransactionsCache(userId);
        } catch (depositError) {
          console.error("❌ ERROR depositing to wallet:", depositError);
        }
      }

      await updatePaymentTransaction(transactionId, {
        orderId: decodedDataToken.order_id,
        paymentId: paymentIdToken,
        status: isPaymentSuccessful ? "completed" : mapPaymentStatus(decodedDataToken.payment_status),
        transactionData: decodedDataToken,
      });

      return {
        success: isPaymentSuccessful,
        message: isPaymentSuccessful ? "Token top-up payment was successful" : "Token top-up payment failed",
        payment_id: paymentIdToken,
        paymentType: "token",
        data: decodedDataToken,
        sign: signToken,
        isPaymentSuccessful,
      };
    }

    if (paymentType === "card") {
      const requestBody = createDepositPaymentRequest(amount, email, transactionId, paymentConfig);
      const response = await sendPaymentCreateRequest(paymentConfig, requestBody);

      const { data, payment_id, sign, success } = response.data;

      if (typeof success === "undefined" || !data || !payment_id || !sign) {
        throw new Error("Invalid API response: missing required fields");
      }

      verifyResponseSignature(data, sign, paymentConfig.secretKey);

      const decodedData: DecodedPaymentData = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));

      console.log("decodedData card top-up", decodedData);

      await updatePaymentTransaction(transactionId, {
        orderId: decodedData.order_id,
        paymentId: payment_id,
        status: mapPaymentStatus(decodedData.payment_status),
        transactionData: decodedData,
      });

      return {
        success,
        message: success ? "Card top-up payment was successful" : "Card top-up payment failed",
        paymentType: "card",
        payment_id,
        data: decodedData,
      };
    }

    throw Object.assign(new Error("Invalid paymentType. Must be 'token' or 'card'"), { statusCode: 400 });
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

    console.log("=== WALLET CALLBACK DEBUG ===");
    console.log("decodedData", JSON.stringify(decodedData, null, 2));
    console.log("transaction", JSON.stringify(transaction, null, 2));

    const isRecurrentPayment = decodedData.order_id?.startsWith("recurrent_");

    if (decodedData.operation_status === "success" && transaction.type === "deposit" && !isRecurrentPayment) {
      console.log("Processing wallet deposit for user", transaction.user_id);

      if (decodedData.recurrent_token) {
        try {
          await createToken({
            userId: transaction.user_id,
            token: decodedData.recurrent_token,
            expired_at: decodedData.payment_date,
            amount: decodedData.amount,
            pan_masked: decodedData.payer_info?.pan_masked,
          });
        } catch (tokenError) {
          console.error("Error saving payment token:", tokenError);
        }
      }

      try {
        await depositUserWallet(transaction.user_id, transaction.currency_id, transaction.amount);
        console.log("Wallet deposit completed:", transaction.amount);
        await clearUserTransactionsCache(transaction.user_id);
      } catch (depositError) {
        console.error("Error depositing to wallet:", depositError);
      }
    } else if (isRecurrentPayment) {
      console.log("SKIPPING wallet deposit for recurrent payment (already processed in /top-up)");
    } else {
      console.log("SKIPPING wallet deposit - conditions not met");
    }

    console.log("=== WALLET CALLBACK DEBUG END ===");

    await updatePaymentTransaction(transaction.id, {
      orderId: decodedData.order_id,
      paymentId: transaction.payment_id,
      status: decodedData.operation_status === "success" ? "completed" : "failed",
      transactionData: decodedData,
    });

    return transaction;
  },

  async getReceipt(userId: number, payment_id: string, order_id: string) {
    if (!paymentConfig.secretKey || !paymentConfig.apiKey || !paymentConfig.apiUrl) {
      throw new Error("Missing required environment variables");
    }

    const transaction = await getTransactionByOrderId(order_id);
    if (!transaction) {
      throw Object.assign(new Error("Transaction not found"), { statusCode: 404 });
    }

    if (transaction.user_id != userId) {
      throw Object.assign(new Error("Access denied: this transaction does not belong to you"), { statusCode: 403 });
    }

    const response = await sendPaymentReceiptRequest(paymentConfig, payment_id, order_id);

    const pdfBuffer = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(response.data as any);

    const filename = `${order_id}_${payment_id}.pdf`;
    const receiptUrl = await uploadToBothBuckets("receipts", pdfBuffer, filename, "application/pdf");

    return receiptUrl;
  },
};
