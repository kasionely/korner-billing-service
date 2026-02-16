import {
  getActiveFeeForCurrency,
  getAllActiveFees,
  calculateFee,
  createPlatformFee,
  updatePlatformFee,
  getFeeHistoryForCurrency,
} from "../../models/fee.model";
import { cacheValues } from "../../utils/cache";
import { verifyAccessToken } from "../../utils/jwt";
import redis from "../../utils/redis";

export const feeService = {
  async getForCurrency(currencyId: number) {
    const cacheKey = `platform_fee:currency:${currencyId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return { cached: true, data: JSON.parse(cached) };

    const fee = await getActiveFeeForCurrency(currencyId);
    if (!fee) return null;

    const responseData = {
      success: true,
      data: {
        currency_id: fee.currency_id,
        fee_percentage: parseFloat(fee.fee_percentage.toString()),
        min_fee_amount: fee.min_fee_amount ? parseFloat(fee.min_fee_amount.toString()) : null,
        max_fee_amount: fee.max_fee_amount ? parseFloat(fee.max_fee_amount.toString()) : null,
      },
    };

    await redis.setex(cacheKey, cacheValues.day, JSON.stringify(responseData));
    return { cached: false, data: responseData };
  },

  async getAll() {
    const cacheKey = "platform_fees:all_active";
    const cached = await redis.get(cacheKey);
    if (cached) return { cached: true, data: JSON.parse(cached) };

    const fees = await getAllActiveFees();

    const responseData = {
      success: true,
      data: fees.map((fee) => ({
        currency_id: fee.currency_id,
        fee_percentage: parseFloat(fee.fee_percentage.toString()),
        min_fee_amount: fee.min_fee_amount ? parseFloat(fee.min_fee_amount.toString()) : null,
        max_fee_amount: fee.max_fee_amount ? parseFloat(fee.max_fee_amount.toString()) : null,
      })),
    };

    await redis.setex(cacheKey, cacheValues.day, JSON.stringify(responseData));
    return { cached: false, data: responseData };
  },

  async calculate(amount: number, currency_id: number) {
    return calculateFee(amount, currency_id);
  },

  async getHistory(currencyId: number) {
    const cacheKey = `platform_fee:history:currency:${currencyId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return { cached: true, data: JSON.parse(cached) };

    const feeHistory = await getFeeHistoryForCurrency(currencyId);

    const responseData = {
      success: true,
      data: feeHistory.map((fee) => ({
        id: fee.id,
        currency_id: fee.currency_id,
        fee_percentage: parseFloat(fee.fee_percentage.toString()),
        min_fee_amount: fee.min_fee_amount ? parseFloat(fee.min_fee_amount.toString()) : null,
        max_fee_amount: fee.max_fee_amount ? parseFloat(fee.max_fee_amount.toString()) : null,
        is_active: fee.is_active,
        created_at: fee.created_at,
        updated_at: fee.updated_at,
      })),
    };

    await redis.setex(cacheKey, cacheValues.day, JSON.stringify(responseData));
    return { cached: false, data: responseData };
  },

  verifyAdminToken(token: string | undefined) {
    if (!token) {
      throw Object.assign(new Error("Authorization token required"), { statusCode: 401 });
    }
    const decoded = verifyAccessToken(token);
    if (decoded.error) {
      throw Object.assign(new Error(decoded.error.message), { statusCode: 401, code: decoded.error.code });
    }
    return decoded;
  },

  async create(body: {
    currency_id: number;
    fee_percentage: number;
    min_fee_amount?: number | null;
    max_fee_amount?: number | null;
  }) {
    const { currency_id, fee_percentage, min_fee_amount, max_fee_amount } = body;

    const newFee = await createPlatformFee({
      currency_id,
      fee_percentage,
      min_fee_amount: min_fee_amount || null,
      max_fee_amount: max_fee_amount || null,
    });

    return {
      id: newFee.id,
      currency_id: newFee.currency_id,
      fee_percentage: parseFloat(newFee.fee_percentage.toString()),
      min_fee_amount: newFee.min_fee_amount ? parseFloat(newFee.min_fee_amount.toString()) : null,
      max_fee_amount: newFee.max_fee_amount ? parseFloat(newFee.max_fee_amount.toString()) : null,
      is_active: newFee.is_active,
    };
  },

  async update(
    feeId: number,
    body: {
      fee_percentage?: number;
      min_fee_amount?: number | null;
      max_fee_amount?: number | null;
      is_active?: boolean;
    }
  ) {
    const { fee_percentage, min_fee_amount, max_fee_amount, is_active } = body;

    const updatedFee = await updatePlatformFee(feeId, {
      fee_percentage,
      min_fee_amount: min_fee_amount === undefined ? undefined : min_fee_amount || null,
      max_fee_amount: max_fee_amount === undefined ? undefined : max_fee_amount || null,
      is_active,
    });

    if (!updatedFee) return null;

    return {
      id: updatedFee.id,
      currency_id: updatedFee.currency_id,
      fee_percentage: parseFloat(updatedFee.fee_percentage.toString()),
      min_fee_amount: updatedFee.min_fee_amount ? parseFloat(updatedFee.min_fee_amount.toString()) : null,
      max_fee_amount: updatedFee.max_fee_amount ? parseFloat(updatedFee.max_fee_amount.toString()) : null,
      is_active: updatedFee.is_active,
    };
  },
};
