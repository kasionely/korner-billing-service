import { Request, Response } from "express";

import { ERROR_CODES } from "../../utils/errorCodes";
import { walletService } from "./wallet.service";

export async function getBalance(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  try {
    const balances = await walletService.getBalance(userId);
    res.status(200).json({ success: true, data: balances });
  } catch (error) {
    console.error("Error fetching user balances:", (error as Error).message);
    res.status(500).json({ success: false, message: "Failed to fetch balances", error: (error as Error).message });
  }
}

export async function getBalanceByCurrency(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  const { currencyId } = req.params;

  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  if (!currencyId || isNaN(Number(currencyId))) {
    res.status(400).json({ success: false, message: "Invalid currency ID" });
    return;
  }

  try {
    const balance = await walletService.getBalanceByCurrency(userId, Number(currencyId));
    if (!balance) {
      res.status(404).json({ success: false, message: "Balance not found for this currency" });
      return;
    }
    res.status(200).json({ success: true, data: balance });
  } catch (error) {
    console.error("Error fetching user balance by currency:", (error as Error).message);
    res.status(500).json({ success: false, message: "Failed to fetch balance", error: (error as Error).message });
  }
}

export async function getTransactions(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  try {
    const result = await walletService.getTransactions(userId, limit, offset);
    res.status(200).json(result.data);
  } catch (error) {
    console.error("Error fetching transaction history:", (error as Error).message);
    res.status(500).json({ success: false, message: "Failed to fetch transaction history", error: (error as Error).message });
  }
}

export async function createWallet(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  try {
    await walletService.createWallet(userId);
    res.status(201).json({ success: true, message: "Wallet created successfully" });
  } catch (error) {
    console.error("Error creating wallet:", (error as Error).message);
    res.status(500).json({ success: false, message: "Failed to create wallet", error: (error as Error).message });
  }
}

export async function topUp(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid user ID" } });
    return;
  }

  try {
    const result = await walletService.topUp(userId, req.body);
    const status = (result as any).isPaymentSuccessful === false ? 400 : 200;
    res.status(status).json(result);
  } catch (error: any) {
    const status = error.statusCode || 500;
    console.error("Ошибка создания платежа для пополнения:", (error as Error).message);
    if (status < 500) {
      res.status(status).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: (error as Error).message } });
    } else {
      res.status(500).json({ message: "Ошибка оплаты", error: (error as Error).message });
    }
  }
}

export async function callback(req: Request, res: Response): Promise<void> {
  const { data, sign } = req.body;

  if (!data || !sign) {
    res.status(400).json({ message: "Invalid API response: missing required fields", error: ERROR_CODES.SERVER_ERROR });
    return;
  }

  try {
    const transaction = await walletService.callback(data, sign);
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

