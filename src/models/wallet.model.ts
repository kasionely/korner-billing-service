import { db } from "../db";

export interface UserBalance {
  userId: number;
  currencyId: number;
  currencyCode: string;
  balance: number;
}

export interface TransactionHistory {
  id: number;
  currencyId: number;
  currencyCode: string;
  amount: string;
  type: string;
  source: string;
  status: string;
  bar?: {
    id: string;
    thumbnail: string;
    title: string;
    owner: string;
  };
  payment?: {
    pan: string;
    token_id: string;
    receipt: {
      payment_id: string;
      order_id: string;
    };
  };
  createdAt: Date;
}

export const getUserBalances = async (userId: number): Promise<UserBalance[]> => {
  const balances = await db("balances as b")
    .join("currencies as c", "b.currency_id", "c.id")
    .select(
      "b.user_id as userId",
      "b.currency_id as currencyId",
      "c.code as currencyCode",
      "b.amount as balance"
    )
    .where("b.user_id", userId);

  return balances.map((balance) => ({
    ...balance,
    userId: parseInt(balance.userId),
    currencyId: parseInt(balance.currencyId),
    balance: parseFloat(balance.balance),
  }));
};

export const getUserBalanceByCurrency = async (
  userId: number,
  currencyId: number
): Promise<UserBalance | null> => {
  const balance = await db("balances as b")
    .join("currencies as c", "b.currency_id", "c.id")
    .select(
      "b.user_id as userId",
      "b.currency_id as currencyId",
      "c.code as currencyCode",
      "b.amount as balance"
    )
    .where("b.user_id", userId)
    .andWhere("b.currency_id", currencyId)
    .first();

  if (!balance) return null;

  return {
    ...balance,
    userId: parseFloat(balance.userId),
    currencyId: parseFloat(balance.currencyId),
    balance: parseFloat(balance.balance),
  };
};

export const getUserTransactionHistory = async (
  userId: number,
  limit: number = 50,
  offset: number = 0
): Promise<TransactionHistory[]> => {
  const transactions = await db("transactions as t")
    .join("currencies as c", "t.currency_id", "c.id")
    .leftJoin("bars as b", "t.bar_id", "b.id")
    .leftJoin("profiles as p", "b.profile_id", "p.id")
    .select(
      "t.id",
      "t.currency_id as currencyId",
      "c.code as currencyCode",
      "t.amount",
      "t.type",
      "t.source",
      "t.status",
      "t.payment_id as paymentId",
      "t.order_id as orderId",
      "t.transaction_data as transactionData",
      "b.id as barDetailsId",
      "b.thumbnail as barThumbnail",
      "b.title as barTitle",
      "p.name as barOwnerName",
      "t.created_at as createdAt"
    )
    .where("t.user_id", userId)
    .orderBy("t.created_at", "desc")
    .limit(limit)
    .offset(offset);

  return transactions.map((transaction) => {
    const transactionData = transaction.transactionData as any;
    const payerInfo = transactionData?.payer_info;

    return {
      id: transaction.id,
      currencyId: transaction.currencyId,
      currencyCode: transaction.currencyCode,
      amount: transaction.amount,
      type: transaction.type,
      source: transaction.source,
      status: transaction.status,
      bar: transaction.barDetailsId
        ? {
            id: transaction.barDetailsId,
            thumbnail: transaction.barThumbnail,
            title: transaction.barTitle,
            owner: transaction.barOwnerName || "",
          }
        : undefined,
      payment: transaction.paymentId
        ? {
            pan: payerInfo?.pan_masked || "****",
            token_id: transactionData?.recurrent_token || "",
            receipt: {
              payment_id: transaction.paymentId,
              order_id: transaction.orderId || "",
            },
          }
        : undefined,
      createdAt: transaction.createdAt,
    };
  });
};

export const createUserWallet = async (userId: number): Promise<void> => {
  const currencies = await db("currencies").select("id");

  for (const currency of currencies) {
    await db("balances")
      .insert({
        user_id: userId,
        currency_id: currency.id,
        amount: "0.00",
      })
      .onConflict(["user_id", "currency_id"])
      .ignore();
  }
};

export const depositUserWallet = async (
  userId: number,
  currencyId: number,
  amount: number
): Promise<void> => {
  await db.transaction(async (trx) => {
    // Проверяем существует ли баланс для пользователя и валюты
    const existingBalance = await trx("balances")
      .where("user_id", userId)
      .andWhere("currency_id", currencyId)
      .first();

    if (existingBalance) {
      // Обновляем существующий баланс
      await trx("balances")
        .where("user_id", userId)
        .andWhere("currency_id", currencyId)
        .increment("amount", amount);
    } else {
      // Создаем новый баланс если его нет
      await trx("balances").insert({
        user_id: userId,
        currency_id: currencyId,
        amount: amount.toString(),
      });
    }
  });
};

export const checkUserBalance = async (
  userId: number,
  currencyId: number,
  requiredAmount: number
): Promise<{ hasEnoughBalance: boolean; currentBalance: number }> => {
  const balance = await getUserBalanceByCurrency(userId, currencyId);

  if (!balance) {
    return { hasEnoughBalance: false, currentBalance: 0 };
  }

  const hasEnoughBalance = balance.balance >= requiredAmount;

  return { hasEnoughBalance, currentBalance: balance.balance };
};

export const deductUserWallet = async (
  userId: number,
  currencyId: number,
  amount: number,
  barId?: string
): Promise<{ success: boolean; transactionId?: number; error?: string }> => {
  try {
    return await db.transaction(async (trx) => {
      // Проверяем баланс пользователя
      const balance = await trx("balances")
        .where("user_id", userId)
        .andWhere("currency_id", currencyId)
        .first();

      if (!balance) {
        return { success: false, error: "User balance not found" };
      }

      const currentBalance = parseFloat(balance.amount);
      if (currentBalance < amount) {
        return {
          success: false,
          error: `Insufficient balance. Current: ${currentBalance}, Required: ${amount}`,
        };
      }

      // Списываем средства с баланса
      await trx("balances")
        .where("user_id", userId)
        .andWhere("currency_id", currencyId)
        .decrement("amount", amount);

      // Создаем запись транзакции
      const [transaction] = await trx("transactions")
        .insert({
          user_id: userId,
          currency_id: currencyId,
          amount,
          type: "withdraw",
          source: "wallet",
          bar_id: barId || null,
          status: "completed",
          created_at: trx.fn.now(),
        })
        .returning("id");

      return { success: true, transactionId: transaction.id };
    });
  } catch (error) {
    console.error("Error deducting wallet balance:", error);
    return { success: false, error: "Database transaction failed" };
  }
};

export const deductUserWalletForSubscription = async (
  userId: number,
  currencyId: number,
  amount: number,
  userSubscriptionId: number
): Promise<{ success: boolean; transactionId?: number; error?: string }> => {
  try {
    return await db.transaction(async (trx) => {
      // Проверяем баланс пользователя
      const balance = await trx("balances")
        .where("user_id", userId)
        .andWhere("currency_id", currencyId)
        .first();

      if (!balance) {
        return { success: false, error: "User balance not found" };
      }

      const currentBalance = parseFloat(balance.amount);
      if (currentBalance < amount) {
        return {
          success: false,
          error: `Insufficient balance. Current: ${currentBalance}, Required: ${amount}`,
        };
      }

      // Списываем средства с баланса
      await trx("balances")
        .where("user_id", userId)
        .andWhere("currency_id", currencyId)
        .decrement("amount", amount);

      // Создаем запись транзакции
      const [transaction] = await trx("transactions")
        .insert({
          user_id: userId,
          currency_id: currencyId,
          amount,
          type: "subscription",
          source: "wallet",
          user_subscription_id: userSubscriptionId,
          status: "completed",
          created_at: trx.fn.now(),
        })
        .returning("id");

      return { success: true, transactionId: transaction.id };
    });
  } catch (error) {
    console.error("Error deducting wallet balance:", error);
    return { success: false, error: "Database transaction failed" };
  }
};
