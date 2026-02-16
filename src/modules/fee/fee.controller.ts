import { Request, Response } from "express";

import { ERROR_CODES } from "../../utils/errorCodes";
import { feeService } from "./fee.service";

export async function getForCurrency(req: Request, res: Response): Promise<void> {
  const currencyId = parseInt(req.params.currencyId);

  if (isNaN(currencyId) || currencyId <= 0) {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Invalid currency ID" } });
    return;
  }

  try {
    const result = await feeService.getForCurrency(currencyId);
    if (!result) {
      res.status(404).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Platform fee not found for this currency" } });
      return;
    }
    res.status(200).json(result.data);
  } catch (error) {
    console.error("Error fetching platform fee:", error);
    res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to fetch platform fee" } });
  }
}

export async function getAll(req: Request, res: Response): Promise<void> {
  try {
    const result = await feeService.getAll();
    res.status(200).json(result.data);
  } catch (error) {
    console.error("Error fetching all platform fees:", error);
    res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to fetch platform fees" } });
  }
}

export async function calculate(req: Request, res: Response): Promise<void> {
  const { amount, currency_id } = req.body;

  if (!amount || !currency_id) {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Amount and currency_id are required" } });
    return;
  }

  if (typeof amount !== "number" || amount <= 0) {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Amount must be a positive number" } });
    return;
  }

  if (typeof currency_id !== "number" || currency_id <= 0) {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Currency ID must be a positive number" } });
    return;
  }

  try {
    const feeCalculation = await feeService.calculate(amount, currency_id);
    res.status(200).json({ success: true, data: feeCalculation });
  } catch (error) {
    console.error("Error calculating fee:", error);
    res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to calculate fee" } });
  }
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  const currencyId = parseInt(req.params.currencyId);

  if (isNaN(currencyId) || currencyId <= 0) {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Invalid currency ID" } });
    return;
  }

  try {
    const result = await feeService.getHistory(currencyId);
    res.status(200).json(result.data);
  } catch (error) {
    console.error("Error fetching fee history:", error);
    res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to fetch fee history" } });
  }
}

export async function createFee(req: Request, res: Response): Promise<void> {
  const token = req.headers.authorization?.split(" ")[1];

  try {
    feeService.verifyAdminToken(token);
  } catch (error: any) {
    res.status(error.statusCode || 401).json({ error: { code: error.code || ERROR_CODES.BASE_AUTH_TOKEN_REQUIRED, message: (error as Error).message } });
    return;
  }

  const { currency_id, fee_percentage, min_fee_amount, max_fee_amount } = req.body;

  if (!currency_id || typeof fee_percentage !== "number") {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Currency ID and fee percentage are required" } });
    return;
  }

  if (fee_percentage < 0 || fee_percentage > 100) {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Fee percentage must be between 0 and 100" } });
    return;
  }

  try {
    const newFee = await feeService.create({ currency_id, fee_percentage, min_fee_amount, max_fee_amount });
    res.status(201).json({ success: true, message: "Platform fee created successfully", data: newFee });
  } catch (error) {
    console.error("Error creating platform fee:", error);
    res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to create platform fee" } });
  }
}

export async function updateFee(req: Request, res: Response): Promise<void> {
  const token = req.headers.authorization?.split(" ")[1];

  try {
    feeService.verifyAdminToken(token);
  } catch (error: any) {
    res.status(error.statusCode || 401).json({ error: { code: error.code || ERROR_CODES.BASE_AUTH_TOKEN_REQUIRED, message: (error as Error).message } });
    return;
  }

  const feeId = parseInt(req.params.feeId);

  if (isNaN(feeId) || feeId <= 0) {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Invalid fee ID" } });
    return;
  }

  const { fee_percentage, min_fee_amount, max_fee_amount, is_active } = req.body;

  if (fee_percentage !== undefined && (fee_percentage < 0 || fee_percentage > 100)) {
    res.status(400).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Fee percentage must be between 0 and 100" } });
    return;
  }

  try {
    const updatedFee = await feeService.update(feeId, { fee_percentage, min_fee_amount, max_fee_amount, is_active });
    if (!updatedFee) {
      res.status(404).json({ error: { code: ERROR_CODES.BAD_REQUEST, message: "Platform fee not found" } });
      return;
    }
    res.status(200).json({ success: true, message: "Platform fee updated successfully", data: updatedFee });
  } catch (error) {
    console.error("Error updating platform fee:", error);
    res.status(500).json({ error: { code: ERROR_CODES.SERVER_ERROR, message: "Failed to update platform fee" } });
  }
}
