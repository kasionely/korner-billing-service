import { Request, Response } from "express";

import { ERROR_CODES } from "../../utils/errorCodes";
import { payoutRequestsService } from "./payout-requests.service";

export async function create(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ code: ERROR_CODES.PAYOUT_UNAUTHORIZED, message: "Authorization required" });
    return;
  }

  try {
    const result = await payoutRequestsService.create(userId, req.body);
    res.status(201).json(result);
  } catch (error: any) {
    console.error("Error creating payout request:", error);
    const status = error.statusCode || 500;
    if (status < 500) {
      res.status(status).json({ code: error.code, message: error.message, fields: error.fields });
    } else {
      res.status(500).json({ code: ERROR_CODES.PAYOUT_SERVER_ERROR, message: "Failed to create payout request" });
    }
  }
}

export async function getAdminList(req: Request, res: Response): Promise<void> {
  try {
    const result = await payoutRequestsService.getAdminList(req.query);
    res.status(200).json(result);
  } catch (error: any) {
    console.error("Error retrieving payout requests list:", error);
    const status = error.statusCode || 500;
    if (status < 500) {
      res.status(status).json({ code: error.code, message: error.message, fields: error.fields });
    } else {
      res.status(500).json({ code: ERROR_CODES.PAYOUT_SERVER_ERROR, message: "Failed to retrieve payout requests" });
    }
  }
}

export async function getAdminDetails(req: Request, res: Response): Promise<void> {
  try {
    const result = await payoutRequestsService.getAdminDetails(req.params.payoutRequestId);
    res.status(200).json(result);
  } catch (error: any) {
    console.error("Error retrieving payout request details:", error);
    const status = error.statusCode || 500;
    if (status < 500) {
      res.status(status).json({ code: error.code, message: error.message });
    } else {
      res.status(500).json({ code: ERROR_CODES.PAYOUT_SERVER_ERROR, message: "Failed to retrieve payout request details" });
    }
  }
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ code: ERROR_CODES.PAYOUT_UNAUTHORIZED, message: "Authentication required" });
    return;
  }

  try {
    const result = await payoutRequestsService.updateStatus(userId, req.params.payoutRequestId, req.body);
    res.status(200).json(result);
  } catch (error: any) {
    console.error("Error updating payout request status:", error);
    const status = error.statusCode || 500;

    if (error.message?.includes("Payout request not found")) {
      res.status(404).json({ code: ERROR_CODES.PAYOUT_REQUEST_NOT_FOUND, message: "Payout request not found" });
      return;
    }

    if (error.message?.includes("Invalid status transition")) {
      res.status(400).json({ code: ERROR_CODES.PAYOUT_INVALID_STATUS, message: "Allowed: created, inReview, processing, paid, rejected, canceled" });
      return;
    }

    if (status < 500) {
      res.status(status).json({ code: error.code, message: error.message, fields: error.fields });
    } else {
      res.status(500).json({ code: ERROR_CODES.PAYOUT_SERVER_ERROR, message: "Failed to update payout request status" });
    }
  }
}
