/**
 * Маппинг статусов платежной системы на внутренние статусы транзакций
 */
export const mapPaymentStatus = (
  paymentStatus: string
): "pending" | "completed" | "failed" | "canceled" => {
  const mappedStatus = (() => {
    switch (paymentStatus?.toLowerCase()) {
      case "success":
      case "completed":
      case "paid":
      case "approved":
      case "withdraw":
        return "completed";

      case "failed":
      case "error":
      case "declined":
      case "rejected":
        return "failed";

      case "cancelled":
      case "canceled":
      case "cancel":
        return "canceled";

      case "pending":
      case "processing":
      case "waiting":
      case "created":
      case "in_progress":
      case "initiated":
      default:
        return "pending";
    }
  })();

  if (paymentStatus && paymentStatus !== "pending") {
    console.log(`Status mapping: "${paymentStatus}" → "${mappedStatus}"`);
  }

  return mappedStatus;
};
