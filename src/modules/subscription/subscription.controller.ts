import { Request, Response } from "express";

import { ERROR_CODES } from "../../utils/errorCodes";
import { subscriptionService } from "./subscription.service";

export async function getPlans(req: Request, res: Response): Promise<void> {
  try {
    const subscriptionPlans = await subscriptionService.getPlans();
    res.status(200).json({ success: true, data: subscriptionPlans });
  } catch (error) {
    console.error("Error fetching subscription plans:", (error as Error).message);
    res.status(500).json({ success: false, message: "Failed to fetch subscription plans", error: (error as Error).message });
  }
}

export async function getInfo(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  try {
    const activeSubscriptionInfo = await subscriptionService.getInfo(userId);
    res.status(200).json({ success: true, data: activeSubscriptionInfo });
  } catch (error) {
    console.error("Error fetching subscription info:", (error as Error).message);
    res.status(500).json({ success: false, message: "Failed to fetch subscription info", error: (error as Error).message });
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;

  console.log("=== SUBSCRIPTION CREATE REQUEST START ===");
  console.log("User ID:", userId);
  console.log("Request body:", JSON.stringify(req.body, null, 2));

  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  try {
    const result = await subscriptionService.create(userId, req.body);
    const isSuccess = (result as any).isPaymentSuccessful !== false;

    res.status(isSuccess ? 200 : 400).json({
      success: isSuccess,
      message: isSuccess ? "Payment completed successfully" : "Payment failed",
      payment_type: result.payment_type,
      ...(result as any).data,
    });
    console.log("=== SUBSCRIPTION CREATE REQUEST END ===");
  } catch (error: any) {
    const status = error.statusCode || 500;
    console.error("Ошибка создания платежа:", (error as Error).message);
    if (status < 500) {
      res.status(status).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: (error as Error).message } });
    } else {
      res.status(500).json({ message: "Ошибка оплаты", error: (error as Error).message });
    }
  }
}

export async function getStatus(req: Request, res: Response): Promise<void> {
  const { transactionId } = req.body;

  try {
    const result = await subscriptionService.getStatus(transactionId);
    res.status(result.success ? 200 : 400).json({
      message: result.success ? "Status retrieved successfully" : "Failed to retrieve status",
      data: result.data,
      sign: result.sign,
    });
  } catch (error) {
    console.error("Ошибка получения статуса платежа:", (error as Error).message);
    res.status(500).json({ message: "Ошибка получения статуса", error: (error as Error).message });
  }
}

export async function recurrent(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  const { amount, token } = req.body;

  try {
    const result = await subscriptionService.recurrent(userId, amount, token);
    res.status(result.success ? 200 : 400).json({
      message: result.success ? "Recurrent payment was successful" : "Recurrent payment failed",
      payment_id: result.payment_id,
      data: result.data,
      sign: result.sign,
    });
  } catch (error) {
    console.error("Ошибка обработки рекуррентного платежа:", (error as Error).message);
    res.status(500).json({ message: "Ошибка обработки рекуррентного платежа", error: (error as Error).message });
  }
}

export async function callback(req: Request, res: Response): Promise<void> {
  const { data, sign } = req.body;

  if (!data || !sign) {
    res.status(400).json({ message: "Invalid API response: missing required fields", error: ERROR_CODES.SERVER_ERROR });
    return;
  }

  try {
    const transaction = await subscriptionService.callback(data, sign);
    res.status(200).json(transaction);
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status === 400) {
      res.status(400).json({ message: (error as Error).message, error: ERROR_CODES.SERVER_ERROR });
    } else if (status === 404) {
      res.status(404).json({ message: "Transaction not found", error: ERROR_CODES.SERVER_ERROR });
    } else {
      console.error("Error responding:", error);
      res.status(500).json({ message: "Something went wrong", error: ERROR_CODES.SERVER_ERROR });
    }
  }
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const sortBy = req.query.sortBy as "created_at" | "expired_at" | "plan_name" | undefined;
    const sortOrder = req.query.sortOrder as "asc" | "desc" | undefined;

    const result = await subscriptionService.getHistory(userId, { page, limit, sortBy, sortOrder });

    res.status(200).json({
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
    res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to retrieve subscription history", details: (error as Error).message } });
  }
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  try {
    const result = await subscriptionService.cancel(userId);
    res.status(200).json({
      success: true,
      message: `Your subscription ends on ${result.formattedDate}`,
      data: {
        plan_name: result.plan_name,
        expires_at: result.expires_at,
        cancelled_at: result.cancelled_at,
      },
    });
  } catch (error: any) {
    const status = error.statusCode || 500;
    console.error("Error cancelling subscription:", (error as Error).message);
    if (status === 404) {
      res.status(404).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: (error as Error).message } });
    } else {
      res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to cancel subscription", details: (error as Error).message } });
    }
  }
}

export async function updateAutoRenewal(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  const { enabled } = req.body;

  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Field 'enabled' must be a boolean" } });
    return;
  }

  try {
    const result = await subscriptionService.updateAutoRenewal(userId, enabled);
    res.status(200).json({
      success: true,
      message: `Auto-renewal ${enabled ? "enabled" : "disabled"} successfully`,
      data: result,
    });
  } catch (error: any) {
    const status = error.statusCode || 500;
    console.error("Error updating auto-renewal setting:", (error as Error).message);
    if (status === 404) {
      res.status(404).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: (error as Error).message } });
    } else {
      res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to update auto-renewal setting", details: (error as Error).message } });
    }
  }
}
