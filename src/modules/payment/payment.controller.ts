import { Request, Response } from "express";

import { ERROR_CODES } from "../../utils/errorCodes";
import { lokiService } from "../../utils/lokiService";
import { paymentService } from "./payment.service";

export async function createPayment(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;

  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  const { email, payment_type, currency_id, token_id, bar_id } = req.body;

  try {
    const result = await paymentService.createPayment(userId, req.body);

    const isSuccess = (result as any).isPaymentSuccessful !== false;
    const status = isSuccess ? 200 : 400;

    res.status(status).json({
      success: isSuccess,
      message: isSuccess ? "Bar purchased successfully" : "Bar purchase failed",
      ...(result as any).data,
      payment_type: result.payment_type,
    });
  } catch (error: any) {
    const status = error.statusCode || 500;
    console.error("Ошибка создания платежа:", (error as Error).message);

    lokiService.logPaymentError({
      userId,
      paymentType: payment_type as "wallet" | "token" | "card",
      error: (error as Error).message,
      details: { bar_id, email, payment_type, currency_id, token_id },
    });

    if (status < 500) {
      res.status(status).json({ error: { code: error.code || ERROR_CODES.BAD_REQUEST, message: (error as Error).message } });
    } else {
      res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to purchase bar", details: (error as Error).message } });
    }
  }
}

export async function getStatus(req: Request, res: Response): Promise<void> {
  const { transactionId } = req.body;

  try {
    const result = await paymentService.getStatus(transactionId);
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

export async function callback(req: Request, res: Response): Promise<void> {
  const { data, sign } = req.body;

  if (!data || !sign) {
    res.status(400).json({ message: "Invalid API response: missing required fields", error: ERROR_CODES.SERVER_ERROR });
    return;
  }

  try {
    const transaction = await paymentService.callback(data, sign);
    res.status(200).json({ success: true, message: "Callback processed successfully", transaction_id: transaction.id });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status === 400) {
      res.status(400).json({ message: (error as Error).message, error: ERROR_CODES.SERVER_ERROR });
    } else if (status === 404) {
      res.status(404).json({ message: "Transaction not found", error: ERROR_CODES.SERVER_ERROR });
    } else {
      console.error("Error responding to callback:", error);
      res.status(500).json({ message: "Something went wrong", error: ERROR_CODES.SERVER_ERROR });
    }
  }
}
