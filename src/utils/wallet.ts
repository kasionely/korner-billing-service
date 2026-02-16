import { createHmac } from "crypto";

export interface DepositConfig {
  secretKey: string;
  apiKey: string;
  apiUrl: string;
  kornerApiUrl: string;
  kornerUrl: string;
  merchantId: string;
  serviceId: string;
  tokenSaveTime: string;
}

export const createDepositPaymentRequest = (
  amount: number,
  email: string,
  transactionId: number,
  config: DepositConfig
): { data: string; sign: string } => {
  const dataObject = {
    amount,
    currency: "KZT",
    order_id: `pay_${Date.now()}`,
    description: "test_desc",
    payment_type: "pay",
    payment_method: "ecom",
    email,
    success_url: `${config.kornerUrl}/finances?transactionId=${transactionId}`,
    failure_url: `${config.kornerUrl}/failure?transactionId=${transactionId}`,
    callback_url: `${config.kornerApiUrl}/api/wallet/callback`,
    merchant_term_url: "https://korner.pro/app/offer/payment-terms",
    payment_lifetime: 3600,
    create_recurrent_profile: true,
    recurrent_profile_lifetime: 365,
    lang: "ru",
    items: [
      {
        merchant_id: config.merchantId,
        service_id: config.serviceId,
        merchant_name: "Korner",
        name: "Korner Wallet Deposit",
        quantity: 1,
        amount_one_pcs: amount,
        amount_sum: amount,
      },
    ],
  };

  const dataJson = JSON.stringify(dataObject);
  const dataBase64 = Buffer.from(dataJson).toString("base64");
  const sign = createHmac("sha512", config.secretKey).update(dataBase64).digest("hex");

  return { data: dataBase64, sign };
};
