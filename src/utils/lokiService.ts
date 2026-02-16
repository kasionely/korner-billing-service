import axios from "axios";

interface LokiLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  service: string;
  environment: string;
  userId?: number;
  event?: string;
  [key: string]: any;
}

class LokiService {
  private lokiUrl: string;
  private serviceName: string;
  private environment: string;
  private isEnabled: boolean;

  constructor() {
    this.lokiUrl = process.env.LOKI_URL || "http://localhost:3100";
    this.serviceName = process.env.SERVICE_NAME || "korner-billing-service";
    this.environment = process.env.ACTIVE_ENV || "development";
    this.isEnabled = process.env.ACTIVE_ENV === "prod" && !!process.env.LOKI_URL;
  }

  private formatTimestamp(): string {
    return (Date.now() * 1000000).toString();
  }

  private async sendToLoki(entry: LokiLogEntry): Promise<void> {
    if (!this.isEnabled) {
      console.log(`[LokiService] Not sending log (disabled): ${entry.message}`);
      return;
    }

    try {
      const labels = {
        service: entry.service,
        environment: entry.environment,
        level: entry.level,
        ...(entry.event && { event: entry.event }),
        ...(entry.userId && { userId: entry.userId.toString() }),
      };

      const logLine = JSON.stringify(entry);

      const payload = {
        streams: [
          {
            stream: labels,
            values: [[this.formatTimestamp(), logLine]],
          },
        ],
      };

      await axios.post(`${this.lokiUrl}/loki/api/v1/push`, payload, {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 5000,
      });

      console.log(`[LokiService] Successfully sent log to Loki: ${entry.event || entry.message}`);
    } catch (error) {
      console.error("[LokiService] Failed to send log to Loki:", error);
    }
  }

  async logBarPurchase(data: {
    userId: number;
    barId: string;
    paymentType: "wallet" | "token" | "card";
    amount: number;
    currency: string;
    transactionId?: number;
    paymentId?: string;
    success: boolean;
    error?: string;
  }): Promise<void> {
    const entry: LokiLogEntry = {
      timestamp: new Date().toISOString(),
      level: data.success ? "info" : "error",
      message: `Bar purchase ${data.success ? "successful" : "failed"}`,
      service: this.serviceName,
      environment: this.environment,
      event: "bar_purchase",
      userId: data.userId,
      barId: data.barId,
      paymentType: data.paymentType,
      amount: data.amount,
      currency: data.currency,
      transactionId: data.transactionId,
      paymentId: data.paymentId,
      success: data.success,
      error: data.error,
    };

    await this.sendToLoki(entry);
  }

  async logSubscriptionPurchase(data: {
    userId: number;
    planId: number;
    priceId: number;
    paymentType: "wallet" | "token" | "card";
    amount: number;
    currency: string;
    subscriptionId?: number;
    transactionId?: number;
    paymentId?: string;
    success: boolean;
    error?: string;
  }): Promise<void> {
    const entry: LokiLogEntry = {
      timestamp: new Date().toISOString(),
      level: data.success ? "info" : "error",
      message: `Subscription purchase ${data.success ? "successful" : "failed"}`,
      service: this.serviceName,
      environment: this.environment,
      event: "subscription_purchase",
      userId: data.userId,
      planId: data.planId,
      priceId: data.priceId,
      paymentType: data.paymentType,
      amount: data.amount,
      currency: data.currency,
      subscriptionId: data.subscriptionId,
      transactionId: data.transactionId,
      paymentId: data.paymentId,
      success: data.success,
      error: data.error,
    };

    await this.sendToLoki(entry);
  }

  async logSubscriptionCancellation(data: {
    userId: number;
    subscriptionId: number;
    planName: string;
    expiresAt: string;
    cancelledAt: string;
  }): Promise<void> {
    const entry: LokiLogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      message: "Subscription cancelled",
      service: this.serviceName,
      environment: this.environment,
      event: "subscription_cancellation",
      userId: data.userId,
      subscriptionId: data.subscriptionId,
      planName: data.planName,
      expiresAt: data.expiresAt,
      cancelledAt: data.cancelledAt,
    };

    await this.sendToLoki(entry);
  }

  async logSubscriptionRenewal(data: {
    userId: number;
    subscriptionId: number;
    planName: string;
    amount: number;
    currency: string;
    success: boolean;
    error?: string;
  }): Promise<void> {
    const entry: LokiLogEntry = {
      timestamp: new Date().toISOString(),
      level: data.success ? "info" : "error",
      message: `Subscription renewal ${data.success ? "successful" : "failed"}`,
      service: this.serviceName,
      environment: this.environment,
      event: "subscription_renewal",
      userId: data.userId,
      subscriptionId: data.subscriptionId,
      planName: data.planName,
      amount: data.amount,
      currency: data.currency,
      success: data.success,
      error: data.error,
    };

    await this.sendToLoki(entry);
  }

  async logWalletOperation(data: {
    userId: number;
    operation: "deposit" | "withdraw";
    amount: number;
    currency: string;
    transactionId: number;
    source: string;
    success: boolean;
    error?: string;
  }): Promise<void> {
    const entry: LokiLogEntry = {
      timestamp: new Date().toISOString(),
      level: data.success ? "info" : "error",
      message: `Wallet ${data.operation} ${data.success ? "successful" : "failed"}`,
      service: this.serviceName,
      environment: this.environment,
      event: "wallet_operation",
      userId: data.userId,
      operation: data.operation,
      amount: data.amount,
      currency: data.currency,
      transactionId: data.transactionId,
      source: data.source,
      success: data.success,
      error: data.error,
    };

    await this.sendToLoki(entry);
  }

  async logPaymentError(data: {
    userId: number;
    paymentType: "wallet" | "token" | "card";
    transactionId?: number;
    paymentId?: string;
    error: string;
    details?: any;
  }): Promise<void> {
    const entry: LokiLogEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      message: `Payment error: ${data.error}`,
      service: this.serviceName,
      environment: this.environment,
      event: "payment_error",
      userId: data.userId,
      paymentType: data.paymentType,
      transactionId: data.transactionId,
      paymentId: data.paymentId,
      error: data.error,
      details: data.details,
    };

    await this.sendToLoki(entry);
  }

  async log(data: {
    level: "info" | "warn" | "error" | "debug";
    message: string;
    event?: string;
    userId?: number;
    [key: string]: any;
  }): Promise<void> {
    const entry: LokiLogEntry = {
      timestamp: new Date().toISOString(),
      service: this.serviceName,
      environment: this.environment,
      ...data,
    };

    await this.sendToLoki(entry);
  }
}

export const lokiService = new LokiService();
export default lokiService;
