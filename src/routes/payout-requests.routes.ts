import { Router, Request, Response } from "express";

import { authMiddleware } from "../middleware/authMiddleware";
import {
  createPayoutRequest,
  getPayoutRequestsList,
  getPayoutRequestDetails,
  updatePayoutRequestStatus,
  CreatePayoutRequestParams,
} from "../models/payout-requests.model";
import {
  createPayoutRequestSchema,
  updatePayoutRequestStatusSchema,
  payoutRequestListQuerySchema,
  payoutRequestIdSchema,
} from "../schemas/payout-requests.schema";
import { toCamelCaseDeep } from "../utils/camelCase";
import { ERROR_CODES } from "../utils/errorCodes";

const router = Router();

interface AuthRequest<P = any, ResBody = any, ReqBody = any> extends Request<P, ResBody, ReqBody> {
  auth?: { userId: number };
}

// POST /api/v1/payout-requests
router.post("/", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({
        code: ERROR_CODES.PAYOUT_UNAUTHORIZED,
        message: "Authorization required",
      });
    }

    // Валидация входных данных
    const validationResult = createPayoutRequestSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errors = validationResult.error.errors.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));

      return res.status(400).json({
        code: ERROR_CODES.PAYOUT_VALIDATION_ERROR,
        message: "Invalid request",
        fields: errors,
      });
    }

    const { requesterName, requesterEmail, phone, preferredContactMethod, context } =
      validationResult.data;

    // TODO: Implement rate limiting
    // const rateLimit = await checkRateLimit(userId);
    // if (rateLimit.exceeded) {
    //   return res.status(429).json({
    //     code: ERROR_CODES.PAYOUT_RATE_LIMITED,
    //     message: "Too many requests. Try again later.",
    //   });
    // }

    const requestParams: CreatePayoutRequestParams = {
      requesterUserId: userId,
      requesterName,
      requesterEmail,
      phone,
      preferredContactMethod,
      context: {
        source: context.source,
        screen: context.screen || undefined,
        url: context.url || undefined,
        metadata: context.metadata || undefined,
      },
    };

    const payoutRequest = await createPayoutRequest(requestParams);

    return res.status(201).json(
      toCamelCaseDeep({
        payout_request_id: `prq_${payoutRequest.id}`,
        status: payoutRequest.status,
        created_at: payoutRequest.created_at,
      })
    );
  } catch (error) {
    console.error("Error creating payout request:", error);

    return res.status(500).json({
      code: ERROR_CODES.PAYOUT_SERVER_ERROR,
      message: "Failed to create payout request",
    });
  }
});

// GET /api/v1/admin/payout-requests (список заявок)
router.get("/admin", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // TODO: Add admin role check
    // if (!isAdmin(req.auth?.userId)) {
    //   return res.status(403).json({
    //     code: ERROR_CODES.PAYOUT_FORBIDDEN,
    //     message: "Admin access required",
    //   });
    // }

    const queryValidation = payoutRequestListQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      const errors = queryValidation.error.errors.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));

      return res.status(400).json({
        code: ERROR_CODES.PAYOUT_VALIDATION_ERROR,
        message: "Invalid query parameters",
        fields: errors,
      });
    }

    const filters = queryValidation.data;
    const { items, total } = await getPayoutRequestsList(filters);

    return res.status(200).json(
      toCamelCaseDeep({
        items,
        page: filters.page,
        page_size: filters.pageSize,
        total,
      })
    );
  } catch (error) {
    console.error("Error retrieving payout requests list:", error);
    return res.status(500).json({
      code: ERROR_CODES.PAYOUT_SERVER_ERROR,
      message: "Failed to retrieve payout requests",
    });
  }
});

// GET /api/v1/admin/payout-requests/{payoutRequestId} (детали заявки)
router.get("/admin/:payoutRequestId", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // TODO: Add admin role check
    // if (!isAdmin(req.auth?.userId)) {
    //   return res.status(403).json({
    //     code: ERROR_CODES.PAYOUT_FORBIDDEN,
    //     message: "Admin access required",
    //   });
    // }

    const requestIdValidation = payoutRequestIdSchema.safeParse(req.params.payoutRequestId);
    if (!requestIdValidation.success) {
      return res.status(400).json({
        code: ERROR_CODES.PAYOUT_INVALID_REQUEST_ID,
        message: "Invalid payout request ID format",
      });
    }

    const requestId = parseInt(req.params.payoutRequestId.replace("prq_", ""));
    const requestDetails = await getPayoutRequestDetails(requestId);

    if (!requestDetails) {
      return res.status(404).json({
        code: ERROR_CODES.PAYOUT_REQUEST_NOT_FOUND,
        message: "Payout request not found",
      });
    }

    return res.status(200).json(toCamelCaseDeep(requestDetails));
  } catch (error) {
    console.error("Error retrieving payout request details:", error);
    return res.status(500).json({
      code: ERROR_CODES.PAYOUT_SERVER_ERROR,
      message: "Failed to retrieve payout request details",
    });
  }
});

// PATCH /api/v1/admin/payout-requests/{payoutRequestId}/status (изменение статуса)
router.patch(
  "/admin/:payoutRequestId/status",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.auth?.userId;
      if (!userId) {
        return res.status(401).json({
          code: ERROR_CODES.PAYOUT_UNAUTHORIZED,
          message: "Authentication required",
        });
      }

      // TODO: Add admin role check
      // if (!isAdmin(userId)) {
      //   return res.status(403).json({
      //     code: ERROR_CODES.PAYOUT_FORBIDDEN,
      //     message: "Admin access required",
      //   });
      // }

      const requestIdValidation = payoutRequestIdSchema.safeParse(req.params.payoutRequestId);
      if (!requestIdValidation.success) {
        return res.status(400).json({
          code: ERROR_CODES.PAYOUT_INVALID_REQUEST_ID,
          message: "Invalid payout request ID format",
        });
      }

      const validationResult = updatePayoutRequestStatusSchema.safeParse(req.body);
      if (!validationResult.success) {
        const errors = validationResult.error.errors.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        }));

        return res.status(400).json({
          code: ERROR_CODES.PAYOUT_VALIDATION_ERROR,
          message: "Invalid request",
          fields: errors,
        });
      }

      const { status, adminComment } = validationResult.data;
      const requestId = parseInt(req.params.payoutRequestId.replace("prq_", ""));

      const updatedRequest = await updatePayoutRequestStatus(
        requestId,
        status,
        userId,
        adminComment
      );

      return res.status(200).json(
        toCamelCaseDeep({
          payout_request_id: `prq_${updatedRequest.id}`,
          status: updatedRequest.status,
          updated_at: updatedRequest.updated_at,
        })
      );
    } catch (error) {
      console.error("Error updating payout request status:", error);

      if (error instanceof Error) {
        if (error.message.includes("Payout request not found")) {
          return res.status(404).json({
            code: ERROR_CODES.PAYOUT_REQUEST_NOT_FOUND,
            message: "Payout request not found",
          });
        }

        if (error.message.includes("Invalid status transition")) {
          return res.status(400).json({
            code: ERROR_CODES.PAYOUT_INVALID_STATUS,
            message: "Allowed: created, inReview, processing, paid, rejected, canceled",
          });
        }
      }

      return res.status(500).json({
        code: ERROR_CODES.PAYOUT_SERVER_ERROR,
        message: "Failed to update payout request status",
      });
    }
  }
);

export default router;
