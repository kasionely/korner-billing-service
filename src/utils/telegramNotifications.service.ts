import axios from "axios";

import { PayoutRequest } from "../models/payout-requests.model";

const TEAM_TELEGRAM_BOT_TOKEN = process.env.TEAM_TELEGRAM_BOT_TOKEN;
const TEAM_TELEGRAM_CHAT_ID = process.env.TEAM_TELEGRAM_CHAT_ID;
const PAYOUTS_REQUESTS_TELEGRAM_CHATID = process.env.PAYOUTS_REQUESTS_TELEGRAM_CHATID;

export class TelegramNotificationsService {
  private async sendTelegramMessage(message: string, chatId: string): Promise<boolean> {
    try {
      if (!TEAM_TELEGRAM_BOT_TOKEN || !chatId) {
        console.error("Telegram bot configuration missing");
        return false;
      }

      await axios.post(`https://api.telegram.org/bot${TEAM_TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      });

      return true;
    } catch (error) {
      console.error("Error sending Telegram message:", error);
      return false;
    }
  }

  async sendPayoutRequestAlert(payoutRequest: PayoutRequest): Promise<boolean> {
    try {
      if (process.env.ACTIVE_ENV !== "prod") {
        console.log(
          `Skipping payout request alert for non-prod environment: ${process.env.ACTIVE_ENV}`
        );
        return true;
      }

      const message = this.formatPayoutRequestMessage(payoutRequest);
      const success = await this.sendTelegramMessage(message, PAYOUTS_REQUESTS_TELEGRAM_CHATID!);

      return success;
    } catch (error) {
      console.error("Error sending payout request alert:", error);
      return false;
    }
  }

  private formatPayoutRequestMessage(payoutRequest: PayoutRequest): string {
    const {
      id,
      requester_name,
      requester_email,
      phone,
      preferred_contact_method,
      source,
      screen,
      created_at,
    } = payoutRequest;

    const contactMethodEmoji = {
      email: "📧",
      phoneCall: "📞",
      whatsApp: "💬",
      telegram: "📱",
    };

    const emoji =
      contactMethodEmoji[preferred_contact_method as keyof typeof contactMethodEmoji] || "📞";
    const createdDate = new Date(created_at).toLocaleString("ru-RU", {
      timeZone: "Asia/Almaty",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    return `🔔 <b>Новая заявка на вывод средств</b>

📋 <b>ID:</b> #${id}
👤 <b>Пользователь:</b> ${requester_name}
📧 <b>Email:</b> ${requester_email}
📱 <b>Телефон:</b> ${phone}
${emoji} <b>Связь:</b> ${preferred_contact_method}

📍 <b>Источник:</b> ${source}${screen ? `\n📱 <b>Экран:</b> ${screen}` : ""}
⏰ <b>Создана:</b> ${createdDate}

<i>Требует рассмотрения команды разработки</i>`;
  }

  async sendStatusChangeAlert(
    payoutRequest: PayoutRequest,
    fromStatus: string,
    toStatus: string,
    adminComment?: string
  ): Promise<boolean> {
    try {
      const message = this.formatStatusChangeMessage(
        payoutRequest,
        fromStatus,
        toStatus,
        adminComment
      );
      return await this.sendTelegramMessage(message, TEAM_TELEGRAM_CHAT_ID!);
    } catch (error) {
      console.error("Error sending status change alert:", error);
      return false;
    }
  }

  private formatStatusChangeMessage(
    payoutRequest: PayoutRequest,
    fromStatus: string,
    toStatus: string,
    adminComment?: string
  ): string {
    const statusEmoji = {
      created: "🆕",
      inReview: "👀",
      processing: "⚙️",
      paid: "✅",
      rejected: "❌",
      canceled: "🚫",
    };

    const fromEmoji = statusEmoji[fromStatus as keyof typeof statusEmoji] || "📝";
    const toEmoji = statusEmoji[toStatus as keyof typeof statusEmoji] || "📝";

    return `🔄 <b>Обновление статуса заявки</b>

📋 <b>ID:</b> #${payoutRequest.id}
👤 <b>Пользователь:</b> ${payoutRequest.requester_name}

${fromEmoji} <b>Было:</b> ${fromStatus}
${toEmoji} <b>Стало:</b> ${toStatus}

${adminComment ? `💬 <b>Комментарий:</b> ${adminComment}` : ""}

⏰ <b>Изменено:</b> ${new Date().toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}`;
  }
}

export const telegramNotificationsService = new TelegramNotificationsService();
