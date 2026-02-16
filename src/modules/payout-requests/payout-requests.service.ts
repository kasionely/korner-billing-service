import {
  createPayoutRequest,
  getPayoutRequestsList,
  getPayoutRequestDetails,
  updatePayoutRequestStatus,
  CreatePayoutRequestParams,
} from "../../models/payout-requests.model";
import {
  createPayoutRequestSchema,
  updatePayoutRequestStatusSchema,
  payoutRequestListQuerySchema,
  payoutRequestIdSchema,
} from "../../schemas/payout-requests.schema";
import { toCamelCaseDeep } from "../../utils/camelCase";
import { ERROR_CODES } from "../../utils/errorCodes";

export const payoutRequestsService = {
  async create(userId: number, body: unknown) {
    const validationResult = createPayoutRequestSchema.safeParse(body);
    if (!validationResult.success) {
      const errors = validationResult.error.errors.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      throw Object.assign(new Error("Invalid request"), {
        statusCode: 400,
        code: ERROR_CODES.PAYOUT_VALIDATION_ERROR,
        fields: errors,
      });
    }

    const { requesterName, requesterEmail, phone, preferredContactMethod, context } = validationResult.data;

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

    return toCamelCaseDeep({
      payout_request_id: `prq_${payoutRequest.id}`,
      status: payoutRequest.status,
      created_at: payoutRequest.created_at,
    });
  },

  async getAdminList(query: unknown) {
    const queryValidation = payoutRequestListQuerySchema.safeParse(query);
    if (!queryValidation.success) {
      const errors = queryValidation.error.errors.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      throw Object.assign(new Error("Invalid query parameters"), {
        statusCode: 400,
        code: ERROR_CODES.PAYOUT_VALIDATION_ERROR,
        fields: errors,
      });
    }

    const filters = queryValidation.data;
    const { items, total } = await getPayoutRequestsList(filters);

    return toCamelCaseDeep({
      items,
      page: filters.page,
      page_size: filters.pageSize,
      total,
    });
  },

  async getAdminDetails(rawId: string) {
    const requestIdValidation = payoutRequestIdSchema.safeParse(rawId);
    if (!requestIdValidation.success) {
      throw Object.assign(new Error("Invalid payout request ID format"), {
        statusCode: 400,
        code: ERROR_CODES.PAYOUT_INVALID_REQUEST_ID,
      });
    }

    const requestId = parseInt(rawId.replace("prq_", ""));
    const requestDetails = await getPayoutRequestDetails(requestId);

    if (!requestDetails) {
      throw Object.assign(new Error("Payout request not found"), {
        statusCode: 404,
        code: ERROR_CODES.PAYOUT_REQUEST_NOT_FOUND,
      });
    }

    return toCamelCaseDeep(requestDetails);
  },

  async updateStatus(userId: number, rawId: string, body: unknown) {
    const requestIdValidation = payoutRequestIdSchema.safeParse(rawId);
    if (!requestIdValidation.success) {
      throw Object.assign(new Error("Invalid payout request ID format"), {
        statusCode: 400,
        code: ERROR_CODES.PAYOUT_INVALID_REQUEST_ID,
      });
    }

    const validationResult = updatePayoutRequestStatusSchema.safeParse(body);
    if (!validationResult.success) {
      const errors = validationResult.error.errors.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      throw Object.assign(new Error("Invalid request"), {
        statusCode: 400,
        code: ERROR_CODES.PAYOUT_VALIDATION_ERROR,
        fields: errors,
      });
    }

    const { status, adminComment } = validationResult.data;
    const requestId = parseInt(rawId.replace("prq_", ""));

    const updatedRequest = await updatePayoutRequestStatus(requestId, status, userId, adminComment);

    return toCamelCaseDeep({
      payout_request_id: `prq_${updatedRequest.id}`,
      status: updatedRequest.status,
      updated_at: updatedRequest.updated_at,
    });
  },
};
