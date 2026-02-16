import { db } from "../db";

interface CreateTransactionParams {
  userId: number;
  currencyId: number;
  amount: number;
  type: "deposit" | "withdraw" | "transfer" | "subscription";
  source: "wallet" | "card";
  userSubscriptionId?: number | null;
  barId?: string | null;
  status?: "pending" | "completed" | "failed" | "canceled";
  orderId?: string;
  paymentId?: string;
  transactionData?: object;
  subscriptionPlanId?: number;
  subscriptionPriceId?: number;
}

interface Transaction {
  id: number;
  user_id: number;
  currency_id: number;
  amount: number;
  type: "deposit" | "withdraw" | "transfer" | "subscription";
  source: "wallet" | "card";
  user_subscription_id?: number;
  bar_id?: string;
  status?: "pending" | "completed" | "failed" | "canceled";
  order_id?: string;
  payment_id?: string;
  transaction_data?: object;
  subscription_plan_id?: number;
  subscription_price_id?: number;
  created_at: Date;
}

export const createTransaction = async ({
  userId,
  currencyId,
  amount,
  type,
  source,
  userSubscriptionId,
  barId,
  status,
  orderId,
  paymentId,
  transactionData,
  subscriptionPlanId,
  subscriptionPriceId,
}: CreateTransactionParams): Promise<number> => {
  const [result] = await db("transactions")
    .insert({
      user_id: userId,
      currency_id: currencyId,
      amount,
      type,
      source,
      user_subscription_id: userSubscriptionId,
      bar_id: barId,
      status,
      order_id: orderId,
      payment_id: paymentId,
      transaction_data: transactionData ? JSON.stringify(transactionData) : null,
      subscription_plan_id: subscriptionPlanId,
      subscription_price_id: subscriptionPriceId,
      created_at: new Date(),
    })
    .returning("id");

  return result.id;
};

export const updateTransaction = async (
  id: number,
  params: Partial<CreateTransactionParams>
): Promise<void> => {
  const updateData: any = {};

  if (params.userId !== undefined) updateData.user_id = params.userId;
  if (params.currencyId !== undefined) updateData.currency_id = params.currencyId;
  if (params.amount !== undefined) updateData.amount = params.amount;
  if (params.type !== undefined) updateData.type = params.type;
  if (params.source !== undefined) updateData.source = params.source;
  if (params.userSubscriptionId !== undefined)
    updateData.user_subscription_id = params.userSubscriptionId;
  if (params.barId !== undefined) updateData.bar_id = params.barId;
  if (params.status !== undefined) updateData.status = params.status;
  if (params.orderId !== undefined) updateData.order_id = params.orderId;
  if (params.paymentId !== undefined) updateData.payment_id = params.paymentId;
  if (params.transactionData !== undefined) {
    updateData.transaction_data = params.transactionData
      ? JSON.stringify(params.transactionData)
      : null;
  }
  if (params.subscriptionPlanId !== undefined)
    updateData.subscription_plan_id = params.subscriptionPlanId;
  if (params.subscriptionPriceId !== undefined)
    updateData.subscription_price_id = params.subscriptionPriceId;

  await db("transactions").where({ id }).update(updateData);
};

export const getTransactionById = async (id: number): Promise<Transaction | null> => {
  const transaction = await db("transactions").where({ id }).first();

  if (!transaction) {
    return null;
  }

  return {
    id: transaction.id,
    user_id: transaction.user_id,
    currency_id: transaction.currency_id,
    amount: parseFloat(transaction.amount),
    type: transaction.type,
    source: transaction.source,
    user_subscription_id: transaction.user_subscription_id,
    bar_id: transaction.bar_id,
    status: transaction.status,
    order_id: transaction.order_id,
    payment_id: transaction.payment_id,
    transaction_data: transaction.transaction_data
      ? typeof transaction.transaction_data === "string"
        ? JSON.parse(transaction.transaction_data)
        : transaction.transaction_data
      : null,
    subscription_plan_id: transaction.subscription_plan_id,
    subscription_price_id: transaction.subscription_price_id,
    created_at: new Date(transaction.created_at),
  };
};

export const getTransactionByOrderId = async (orderId: string): Promise<Transaction | null> => {
  const transaction = await db("transactions").where({ order_id: orderId }).first();

  if (!transaction) {
    return null;
  }

  return {
    id: transaction.id,
    user_id: transaction.user_id,
    currency_id: transaction.currency_id,
    amount: parseFloat(transaction.amount),
    type: transaction.type,
    source: transaction.source,
    user_subscription_id: transaction.user_subscription_id,
    bar_id: transaction.bar_id,
    status: transaction.status,
    order_id: transaction.order_id,
    payment_id: transaction.payment_id,
    transaction_data: transaction.transaction_data
      ? typeof transaction.transaction_data === "string"
        ? JSON.parse(transaction.transaction_data)
        : transaction.transaction_data
      : null,
    subscription_plan_id: transaction.subscription_plan_id,
    subscription_price_id: transaction.subscription_price_id,
    created_at: new Date(transaction.created_at),
  };
};

export const hasUserPurchasedBar = async (userId: number, barId: string): Promise<boolean> => {
  const transaction = await db("transactions")
    .where({
      user_id: userId,
      bar_id: barId,
      status: "completed",
    })
    .andWhere("type", "!=", "subscription")
    .first();

  return !!transaction;
};

export const getUserPurchasedBars = async (
  userId: number,
  limit: number = 50,
  offset: number = 0
): Promise<Array<any>> => {
  const transactions = await db("transactions")
    .select([
      "transactions.id as transaction_id",
      "transactions.bar_id",
      "transactions.amount",
      "transactions.currency_id",
      "transactions.type",
      "transactions.source",
      "transactions.status",
      "transactions.created_at as purchase_date",
      "transactions.payment_id",
      "transactions.order_id",
      "transactions.transaction_data",
    ])
    .where({
      "transactions.user_id": userId,
      "transactions.status": "completed",
    })
    .whereNotNull("transactions.bar_id")
    .andWhere("transactions.type", "!=", "subscription")
    .orderBy("transactions.created_at", "desc")
    .limit(limit)
    .offset(offset);

  return transactions.map((transaction) => {
    const transactionData = transaction.transaction_data as any;
    const payerInfo = transactionData?.payer_info;

    return {
      transaction_id: transaction.transaction_id,
      bar_id: transaction.bar_id,
      amount_paid: parseFloat(transaction.amount),
      currency_id: transaction.currency_id,
      type: transaction.type,
      source: transaction.source,
      status: transaction.status,
      purchase_date: transaction.purchase_date,
      payment_id: transaction.payment_id,
      order_id: transaction.order_id,
      payment: transaction.payment_id
        ? {
            pan: payerInfo?.pan_masked || "****",
            token_id: transactionData?.recurrent_token || "",
            receipt: {
              payment_id: transaction.payment_id,
              order_id: transaction.order_id || "",
            },
          }
        : undefined,
    };
  });
};

export const createPaymentTransaction = createTransaction;
export const updatePaymentTransaction = updateTransaction;
