import axios, { AxiosResponse } from "axios";
import { createHmac } from "crypto";

export interface PaymentApiResponse {
  data: string;
  payment_id: string;
  sign: string;
  success: boolean;
}

export interface PaymentStatusResponse {
  data: string;
  sign: string;
  success: boolean;
}

export interface DecodedCallbackData {
  payment_id: number;
  operation_id: number;
  order_id: string;
  payment_type: string;
  operation_type: string;
  operation_status: string;
  recurrent_token: string;
  amount: number;
  amount_initial: number;
  created_date: string;
  payment_date: string;
  payer_info: {
    pan_masked: string;
    holder: string;
    email: string;
    phone: string;
  };
  extra_params: string | null;
  phone_number: string;
}

export interface DecodedPaymentData {
  order_id: string;
  payment_status: string;
  [key: string]: unknown;
}

export interface PaymentConfig {
  secretKey: string;
  apiKey: string;
  apiUrl: string;
  kornerApiUrl: string;
  kornerUrl: string;
  merchantId: string;
  serviceId: string;
}

export interface PaymentRedirectUrls {
  success_url?: string;
  failure_url?: string;
}

export const createPaymentRequestBody = (
  amount: number,
  email: string,
  transactionId: number,
  config: PaymentConfig,
  barId?: number,
  redirectUrls?: PaymentRedirectUrls
): { data: string; sign: string } => {
  const defaultSuccessUrl = barId
    ? `${config.kornerUrl}/bars/${barId}?transactionId=${transactionId}`
    : `${config.kornerUrl}/success?transactionId=${transactionId}`;
  const defaultFailureUrl = barId
    ? `${config.kornerUrl}/bar/purchase/${barId}?transactionId=${transactionId}`
    : `${config.kornerUrl}/failure?transactionId=${transactionId}`;

  const dataObject = {
    amount,
    currency: "KZT",
    order_id: `pay_${Date.now()}`,
    description: "test_desc",
    payment_type: "pay",
    payment_method: "ecom",
    email,
    success_url: redirectUrls?.success_url || defaultSuccessUrl,
    failure_url: redirectUrls?.failure_url || defaultFailureUrl,
    callback_url: `${config.kornerApiUrl}/api/payment/callback`,
    merchant_term_url: "https://korner.pro/app/offer/payment-terms",
    payment_lifetime: 3600,
    create_recurrent_profile: true,
    recurrent_profile_lifetime: 365,
    lang: "ru",
    items: [
      {
        merchant_id: config.merchantId,
        service_id: config.serviceId,
        merchant_name: "Korner Pro",
        name: "Korner",
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

export const createPaymentStatusRequestBody = (
  orderId: string,
  config: PaymentConfig
): { data: string; sign: string } => {
  const dataObject = {
    ...(process.env.ACTIVE_ENV === "dev" ? { test_mode: 1 } : {}),
    order_id: orderId,
  };

  const dataJson = JSON.stringify(dataObject);
  const dataBase64 = Buffer.from(dataJson).toString("base64");
  const sign = createHmac("sha512", config.secretKey).update(dataBase64).digest("hex");

  return { data: dataBase64, sign };
};

export const verifyResponseSignature = (data: string, sign: string, secretKey: string): void => {
  const calculatedSign = createHmac("sha512", secretKey).update(data).digest("hex");
  if (calculatedSign !== sign) {
    throw new Error("Invalid response signature");
  }
};

export const createPaymentRecurrentRequestBody = (
  token: string,
  amount: number,
  config: PaymentConfig
): { data: string; sign: string } => {
  const dataObject = {
    token,
    amount,
    order_id: `recurrent_${Date.now()}`,
    description: "Test recurrent",
  };

  const dataJson = JSON.stringify(dataObject);
  const dataBase64 = Buffer.from(dataJson).toString("base64");
  const sign = createHmac("sha512", config.secretKey).update(dataBase64).digest("hex");

  return { data: dataBase64, sign };
};

export const sendPaymentCreateRequest = async (
  config: PaymentConfig,
  requestBody: { data: string; sign: string }
): Promise<AxiosResponse<PaymentApiResponse>> => {
  const token = Buffer.from(config.apiKey).toString("base64");
  return axios.post<PaymentApiResponse>(`${config.apiUrl}/payment/create`, requestBody, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
};

export const sendPaymentStatusRequest = async (
  config: PaymentConfig,
  requestBody: { data: string; sign: string }
): Promise<AxiosResponse<PaymentStatusResponse>> => {
  const token = Buffer.from(config.apiKey).toString("base64");
  return axios.post<PaymentStatusResponse>(`${config.apiUrl}/payment/status`, requestBody, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
};

export const sendPaymentRecurrentRequest = async (
  config: PaymentConfig,
  requestBody: { data: string; sign: string }
): Promise<AxiosResponse<PaymentApiResponse>> => {
  const token = Buffer.from(config.apiKey).toString("base64");
  return axios.post<PaymentApiResponse>(`${config.apiUrl}/payment/recurrent`, requestBody, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
};

