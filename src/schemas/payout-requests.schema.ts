import { z } from "zod";

export const createPayoutRequestSchema = z.object({
  requesterName: z
    .string()
    .min(1, "Requester name is required")
    .max(255, "Requester name must be at most 255 characters"),
  requesterEmail: z
    .string()
    .email("Invalid email format")
    .max(255, "Email must be at most 255 characters"),
  phone: z.string().min(1, "Phone is required").max(30, "Phone must be at most 30 characters"),
  preferredContactMethod: z.enum(["email", "phoneCall", "whatsApp", "telegram"]),
  context: z.object({
    source: z.string().min(1, "Source is required"),
    screen: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    metadata: z.any().nullable().optional(),
  }),
});

export const updatePayoutRequestStatusSchema = z.object({
  status: z.enum(["created", "inReview", "processing", "paid", "rejected", "canceled"]),
  adminComment: z.string().max(500, "Admin comment must be at most 500 characters").optional(),
});

export const payoutRequestListQuerySchema = z.object({
  status: z.enum(["created", "inReview", "processing", "paid", "rejected", "canceled"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  requesterUserId: z.string().optional(),
  page: z
    .string()
    .transform((val) => parseInt(val, 10))
    .default("1"),
  pageSize: z
    .string()
    .transform((val) => Math.min(parseInt(val, 10), 100))
    .default("20"),
});

export const payoutRequestIdSchema = z
  .string()
  .regex(/^prq_\d+$/, "Invalid payout request ID format");
