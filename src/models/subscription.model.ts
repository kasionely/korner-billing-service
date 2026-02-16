import { db } from "../db";

export interface SubscriptionPlanDescription {
  en: string;
  ru: string;
}

export interface SubscriptionPlan {
  id: number;
  name: string;
  period: "daily" | "monthly" | "yearly";
  description?: SubscriptionPlanDescription;
  created_at: Date;
  updated_at: Date;
  prices: SubscriptionPrice[];
}

export interface SubscriptionPrice {
  id: number;
  currency: "KZT" | "USD" | "EUR";
  price: string;
  created_at: Date;
  updated_at: Date;
}

export interface UserSubscription {
  id: number;
  user_id: number;
  subscription_plan_id: number;
  is_auto_renewal: boolean;
  payment_method?: "wallet" | "card";
  masked_pan?: string;
  created_at: Date;
  expired_at: Date;
  cancelled_at?: Date;
}

export interface CreateSubscriptionParams {
  userId: number;
  subscriptionPlanId: number;
  isAutoRenewal?: boolean;
  paymentMethod?: "wallet" | "card";
  maskedPan?: string;
}

export interface ExtendSubscriptionParams {
  userId: number;
  durationMonths: number;
}

export const getAllSubscriptionPlansWithPrices = async (): Promise<SubscriptionPlan[]> => {
  const subscriptionPlans = await db("subscription_plans as sp")
    .leftJoin("subscription_plans_prices as spp", "sp.id", "spp.subscription_plan_id")
    .leftJoin("currencies as c", "spp.currency_id", "c.id")
    .select(
      "sp.id",
      "sp.name",
      "sp.period",
      "sp.description",
      "sp.created_at",
      "sp.updated_at",
      db.raw(`
        COALESCE(
          json_agg(
            CASE WHEN spp.id IS NOT NULL THEN
              json_build_object(
                'id', spp.id,
                'currency', c.code,
                'price', spp.price,
                'created_at', spp.created_at,
                'updated_at', spp.updated_at
              )
            ELSE NULL END
          ) FILTER (WHERE spp.id IS NOT NULL),
          '[]'::json
        ) as prices
      `)
    )
    .groupBy("sp.id", "sp.name", "sp.period", "sp.description", "sp.created_at", "sp.updated_at")
    .orderBy("sp.created_at", "asc");

  // Явно преобразуем id в число для каждого плана и цен, а также обрабатываем description
  return subscriptionPlans.map((plan) => ({
    ...plan,
    id: Number(plan.id),
    description: plan.description
      ? typeof plan.description === "string"
        ? JSON.parse(plan.description)
        : plan.description
      : undefined,
    prices: plan.prices.map((price: any) => ({
      ...price,
      id: Number(price.id),
    })),
  }));
};

export interface SubscriptionPlanPrice {
  plan_id: number;
  plan_name: string;
  price_id: number;
  currency_id: number;
  currency_code: string;
  price: string;
}

export const getSubscriptionPlanPrice = async (
  planId: number,
  priceId: number
): Promise<SubscriptionPlanPrice | null> => {
  const result = await db("subscription_plans as sp")
    .join("subscription_plans_prices as spp", "sp.id", "spp.subscription_plan_id")
    .join("currencies as c", "spp.currency_id", "c.id")
    .where("sp.id", planId)
    .where("spp.id", priceId)
    .select(
      "sp.id as plan_id",
      "sp.name as plan_name",
      "spp.id as price_id",
      "c.id as currency_id",
      "c.code as currency_code",
      "spp.price"
    )
    .first();

  return result || null;
};

export const createSubscription = async (
  params: CreateSubscriptionParams
): Promise<UserSubscription> => {
  const { userId, subscriptionPlanId, isAutoRenewal = false, paymentMethod, maskedPan } = params;

  return db.transaction(async (trx) => {
    // Check if subscription plan exists
    const subscriptionPlan = await trx("subscription_plans")
      .where("id", subscriptionPlanId)
      .first();

    if (!subscriptionPlan) {
      throw new Error(`Subscription plan with ID ${subscriptionPlanId} not found`);
    }

    // Check if user exists
    const user = await trx("users").where("id", userId).first();
    if (!user) {
      throw new Error(`User with ID ${userId} not found`);
    }

    // Calculate duration based on subscription plan period
    let intervalString = "";
    switch (subscriptionPlan.period) {
      case "daily":
        intervalString = "1 day";
        break;
      case "monthly":
        intervalString = "1 month";
        break;
      case "yearly":
        intervalString = "1 year";
        break;
      default:
        throw new Error(`Unknown subscription plan period: ${subscriptionPlan.period}`);
    }

    // Create new subscription
    const [newSubscription] = await trx("user_subscriptions")
      .insert({
        user_id: userId,
        subscription_plan_id: subscriptionPlanId,
        is_auto_renewal: isAutoRenewal,
        payment_method: paymentMethod,
        masked_pan: maskedPan,
        created_at: trx.fn.now(),
        expired_at: trx.raw(`NOW() + INTERVAL '${intervalString}'`),
      })
      .returning("*");

    return newSubscription;
  });
};

export const extendSubscription = async (
  params: ExtendSubscriptionParams
): Promise<UserSubscription> => {
  const { userId, durationMonths } = params;

  return db.transaction(async (trx) => {
    // Find active subscription
    const activeSubscription = await trx("user_subscriptions")
      .where("user_id", userId)
      .where("expired_at", ">", trx.fn.now())
      .first();

    if (!activeSubscription) {
      throw new Error(`No active subscription found for user ${userId}`);
    }

    // Extend subscription
    const [extendedSubscription] = await trx("user_subscriptions")
      .where("id", activeSubscription.id)
      .update({
        expired_at: trx.raw(`expired_at + INTERVAL '${durationMonths} months'`),
        created_at: trx.fn.now(),
      })
      .returning("*");

    return extendedSubscription;
  });
};

export const cancelSubscription = async (userId: number): Promise<boolean> => {
  return db.transaction(async (trx) => {
    // Find active subscription
    const activeSubscription = await trx("user_subscriptions")
      .where("user_id", userId)
      .where("expired_at", ">", trx.fn.now())
      .first();

    if (!activeSubscription) {
      throw new Error(`No active subscription found for user ${userId}`);
    }

    // Cancel subscription by disabling auto-renewal and setting cancelled_at timestamp
    const updatedRows = await trx("user_subscriptions").where("id", activeSubscription.id).update({
      is_auto_renewal: false,
      cancelled_at: trx.fn.now(),
    });

    return updatedRows > 0;
  });
};

export interface ActiveSubscriptionInfo {
  hasActiveSubscription: boolean;
  subscriptionPlan?: string;
  planId?: number;
  period?: "daily" | "monthly" | "yearly";
  expiresAt?: Date;
  isAutoRenewal?: boolean;
  paymentMethod?: "wallet" | "card";
  maskedPan?: string;
  cancelledAt?: Date | null;
}

export const getActiveSubscriptionInfo = async (
  userId: number
): Promise<ActiveSubscriptionInfo> => {
  try {
    const activeSubscription = await db("user_subscriptions as us")
      .join("subscription_plans as sp", "us.subscription_plan_id", "sp.id")
      .where("us.user_id", userId)
      .where("us.expired_at", ">", db.fn.now())
      .select(
        "sp.id as plan_id",
        "sp.name as plan_name",
        "sp.period",
        "us.expired_at",
        "us.is_auto_renewal",
        "us.payment_method",
        "us.masked_pan",
        "us.cancelled_at"
      )
      .first();

    if (!activeSubscription) {
      return { hasActiveSubscription: false };
    }

    return {
      hasActiveSubscription: true,
      planId: Number(activeSubscription.plan_id),
      subscriptionPlan: activeSubscription.plan_name,
      period: activeSubscription.period,
      expiresAt: activeSubscription.expired_at,
      isAutoRenewal: activeSubscription.is_auto_renewal,
      paymentMethod: activeSubscription.payment_method,
      maskedPan: activeSubscription.masked_pan,
      cancelledAt: activeSubscription.cancelled_at,
    };
  } catch (error) {
    console.error("Error checking active subscription:", error);
    return { hasActiveSubscription: false };
  }
};

export const deleteSubscription = async (subscriptionId: number): Promise<boolean> => {
  try {
    const deletedRows = await db("user_subscriptions").where("id", subscriptionId).del();

    return deletedRows > 0;
  } catch (error) {
    console.error("Error deleting subscription:", error);
    return false;
  }
};

export interface TransactionSubscriptionInfo {
  plan_id: number;
  plan_name: string;
  plan_period: "daily" | "monthly" | "yearly";
  price_id: number;
  currency_code: string;
  price: string;
}

export const getSubscriptionInfoByTransactionId = async (
  transactionId: number
): Promise<TransactionSubscriptionInfo | null> => {
  try {
    const result = await db("transactions as t")
      .join("subscription_plans as sp", "t.subscription_plan_id", "sp.id")
      .join("subscription_plans_prices as spp", "t.subscription_price_id", "spp.id")
      .join("currencies as c", "spp.currency_id", "c.id")
      .where("t.id", transactionId)
      .select(
        "sp.id as plan_id",
        "sp.name as plan_name",
        "sp.period as plan_period",
        "spp.id as price_id",
        "c.code as currency_code",
        "spp.price"
      )
      .first();

    return result || null;
  } catch (error) {
    console.error("Error getting subscription info by transaction ID:", error);
    return null;
  }
};

export interface UserSubscriptionHistory {
  id: number;
  plan_name: string;
  period: "daily" | "monthly" | "yearly";
  description?: SubscriptionPlanDescription;
  is_auto_renewal: boolean;
  created_at: Date;
  expired_at: Date;
  is_active: boolean;
  currency_code?: string;
  price?: number;
}

export interface SubscriptionHistoryParams {
  page?: number;
  limit?: number;
  sortBy?: "created_at" | "expired_at" | "plan_name";
  sortOrder?: "asc" | "desc";
}

export interface PaginatedSubscriptionHistory {
  subscriptions: UserSubscriptionHistory[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const ALLOWED_SORT_FIELDS = ["created_at", "expired_at", "plan_name"] as const;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export const getUserSubscriptionHistory = async (
  userId: number,
  params: SubscriptionHistoryParams = {}
): Promise<PaginatedSubscriptionHistory> => {
  try {
    const page = Math.max(1, params.page || DEFAULT_PAGE);
    const limit = Math.min(Math.max(1, params.limit || DEFAULT_LIMIT), MAX_LIMIT);
    const sortBy = ALLOWED_SORT_FIELDS.includes(params.sortBy as any)
      ? params.sortBy!
      : "created_at";
    const sortOrder = params.sortOrder === "asc" ? "asc" : "desc";
    const offset = (page - 1) * limit;

    // Map sortBy to actual column names
    const sortColumn = sortBy === "plan_name" ? "sp.name" : `us.${sortBy}`;

    // Get total count
    const [{ count }] = await db("user_subscriptions as us")
      .where("us.user_id", userId)
      .count("us.id as count");

    const total = Number(count);

    // Get paginated subscriptions
    // Use subqueries for price/currency to avoid duplicates from multiple prices per plan
    const subscriptions = await db("user_subscriptions as us")
      .join("subscription_plans as sp", "us.subscription_plan_id", "sp.id")
      .where("us.user_id", userId)
      .select(
        "us.id",
        "sp.name as plan_name",
        "sp.period",
        "sp.description",
        "us.is_auto_renewal",
        "us.created_at",
        "us.expired_at",
        db.raw("(us.expired_at > NOW()) as is_active"),
        // Get price from transaction, fallback to first plan price
        db.raw(`
          COALESCE(
            (SELECT spp.price FROM transactions t
             JOIN subscription_plans_prices spp ON t.subscription_price_id = spp.id
             WHERE t.user_subscription_id = us.id
               AND t.user_id = us.user_id
               AND t.type = 'subscription'
               AND t.status = 'completed'
             ORDER BY t.created_at DESC LIMIT 1),
            (SELECT spp.price FROM subscription_plans_prices spp
             WHERE spp.subscription_plan_id = sp.id LIMIT 1)
          ) as price
        `),
        // Get currency from transaction, fallback to first plan price currency
        db.raw(`
          COALESCE(
            (SELECT c.code FROM transactions t
             JOIN subscription_plans_prices spp ON t.subscription_price_id = spp.id
             JOIN currencies c ON spp.currency_id = c.id
             WHERE t.user_subscription_id = us.id
               AND t.user_id = us.user_id
               AND t.type = 'subscription'
               AND t.status = 'completed'
             ORDER BY t.created_at DESC LIMIT 1),
            (SELECT c.code FROM subscription_plans_prices spp
             JOIN currencies c ON spp.currency_id = c.id
             WHERE spp.subscription_plan_id = sp.id LIMIT 1)
          ) as currency_code
        `)
      )
      .orderBy(sortColumn, sortOrder)
      .limit(limit)
      .offset(offset);

    const mappedSubscriptions = subscriptions.map((subscription) => ({
      ...subscription,
      id: Number(subscription.id),
      description: subscription.description
        ? typeof subscription.description === "string"
          ? JSON.parse(subscription.description)
          : subscription.description
        : undefined,
      is_active: Boolean(subscription.is_active),
      currency_code: subscription.currency_code || undefined,
      price: subscription.price ? Number(subscription.price) : undefined,
    }));

    return {
      subscriptions: mappedSubscriptions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  } catch (error) {
    console.error("Error getting user subscription history:", error);
    return {
      subscriptions: [],
      total: 0,
      page: 1,
      limit: DEFAULT_LIMIT,
      totalPages: 0,
    };
  }
};
