import { Knex } from "knex";

import { db } from "../db";
import { telegramNotificationsService } from "../utils/telegramNotifications.service";

export interface PayoutRequest {
  id: number;
  status: "created" | "inReview" | "processing" | "paid" | "rejected" | "canceled";
  requester_user_id: number;
  requester_name: string;
  requester_email: string;
  phone: string;
  preferred_contact_method: "email" | "phoneCall" | "whatsApp" | "telegram";
  source: string;
  screen?: string;
  url?: string;
  metadata?: any;
  telegram_alert_status: "pending" | "sent" | "failed";
  telegram_alert_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface PayoutRequestStatusHistory {
  id: number;
  payout_request_id: number;
  from_status: string;
  to_status: string;
  changed_by_admin_user_id: number;
  admin_comment?: string;
  created_at: string;
}

export interface CreatePayoutRequestParams {
  requesterUserId: number;
  requesterName: string;
  requesterEmail: string;
  phone: string;
  preferredContactMethod: "email" | "phoneCall" | "whatsApp" | "telegram";
  context: {
    source: string;
    screen?: string;
    url?: string;
    metadata?: any;
  };
}

export interface PayoutRequestListFilter {
  status?: "created" | "inReview" | "processing" | "paid" | "rejected" | "canceled";
  dateFrom?: string;
  dateTo?: string;
  requesterUserId?: string;
  page?: number;
  pageSize?: number;
}

export interface PayoutRequestListItem {
  payoutRequestId: string;
  status: string;
  createdAt: string;
  requester: {
    userId: string;
    name: string;
    email: string;
    phone: string;
    preferredContactMethod: string;
  };
  context: {
    source: string;
    screen?: string;
  };
}

export interface PayoutRequestDetails extends PayoutRequestListItem {
  updatedAt: string;
  context: {
    source: string;
    screen?: string;
    url?: string;
    metadata?: any;
  };
  telegramAlert: {
    status: string;
    attempts: number;
  };
}

export const createPayoutRequest = async (
  params: CreatePayoutRequestParams,
  trx?: Knex.Transaction
): Promise<PayoutRequest> => {
  const query = trx || db;

  const requestData = {
    status: "created" as const,
    requester_user_id: params.requesterUserId,
    requester_name: params.requesterName,
    requester_email: params.requesterEmail,
    phone: params.phone,
    preferred_contact_method: params.preferredContactMethod,
    source: params.context.source,
    screen: params.context.screen || null,
    url: params.context.url || null,
    metadata: params.context.metadata || null,
    telegram_alert_status: "pending" as const,
    telegram_alert_attempts: 0,
  };

  const [createdRequest] = await query("payout_requests").insert(requestData).returning("*");

  process.nextTick(async () => {
    try {
      await telegramNotificationsService.sendPayoutRequestAlert(createdRequest);
    } catch (error) {
      console.error("Failed to send Telegram notification for payout request:", error);
    }
  });

  return createdRequest;
};

export const getPayoutRequestById = async (requestId: number): Promise<PayoutRequest | null> => {
  const request = await db("payout_requests").where({ id: requestId }).first();
  return request || null;
};

export const getPayoutRequestsList = async (
  filters: PayoutRequestListFilter
): Promise<{ items: PayoutRequestListItem[]; total: number }> => {
  const { status, dateFrom, dateTo, requesterUserId, page = 1, pageSize = 20 } = filters;

  let query = db("payout_requests as pr").select(
    "pr.id",
    "pr.status",
    "pr.created_at",
    "pr.requester_user_id",
    "pr.requester_name",
    "pr.requester_email",
    "pr.phone",
    "pr.preferred_contact_method",
    "pr.source",
    "pr.screen"
  );

  if (status) {
    query = query.where("pr.status", status);
  }
  if (dateFrom) {
    query = query.where("pr.created_at", ">=", dateFrom);
  }
  if (dateTo) {
    query = query.where("pr.created_at", "<=", dateTo);
  }
  if (requesterUserId) {
    query = query.where("pr.requester_user_id", requesterUserId);
  }

  const countQuery = query.clone().count("* as total");
  const [{ total }] = await countQuery;

  const offset = (page - 1) * pageSize;
  const items = await query.orderBy("pr.created_at", "desc").limit(pageSize).offset(offset);

  return {
    items: items.map((item) => ({
      payoutRequestId: `prq_${item.id}`,
      status: item.status,
      createdAt: item.created_at,
      requester: {
        userId: `usr_${item.requester_user_id}`,
        name: item.requester_name,
        email: item.requester_email,
        phone: item.phone,
        preferredContactMethod: item.preferred_contact_method,
      },
      context: {
        source: item.source,
        screen: item.screen,
      },
    })),
    total: Number(total),
  };
};

export const getPayoutRequestDetails = async (
  requestId: number
): Promise<PayoutRequestDetails | null> => {
  const request = await db("payout_requests").where({ id: requestId }).first();

  if (!request) return null;

  return {
    payoutRequestId: `prq_${request.id}`,
    status: request.status,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
    requester: {
      userId: `usr_${request.requester_user_id}`,
      name: request.requester_name,
      email: request.requester_email,
      phone: request.phone,
      preferredContactMethod: request.preferred_contact_method,
    },
    context: {
      source: request.source,
      screen: request.screen,
      url: request.url,
      metadata: request.metadata,
    },
    telegramAlert: {
      status: request.telegram_alert_status,
      attempts: request.telegram_alert_attempts,
    },
  };
};

export const updatePayoutRequestStatus = async (
  requestId: number,
  newStatus: "created" | "inReview" | "processing" | "paid" | "rejected" | "canceled",
  adminUserId: number,
  adminComment?: string,
  trx?: Knex.Transaction
): Promise<PayoutRequest> => {
  const query = trx || db;

  const currentRequest = await getPayoutRequestById(requestId);
  if (!currentRequest) {
    throw new Error(`Payout request not found: ${requestId}`);
  }

  const [updatedRequest] = await query("payout_requests")
    .where({ id: requestId })
    .update({
      status: newStatus,
      updated_at: query.fn.now(),
    })
    .returning("*");

  await query("payout_request_status_history").insert({
    payout_request_id: requestId,
    from_status: currentRequest.status,
    to_status: newStatus,
    changed_by_admin_user_id: adminUserId,
    admin_comment: adminComment || null,
  });

  if (currentRequest.status !== newStatus) {
    process.nextTick(async () => {
      try {
        await telegramNotificationsService.sendStatusChangeAlert(
          updatedRequest,
          currentRequest.status,
          newStatus,
          adminComment
        );
      } catch (error) {
        console.error("Failed to send status change notification:", error);
      }
    });
  }

  return updatedRequest;
};
