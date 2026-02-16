import { db } from "../db";

export interface PlatformFee {
  id: number;
  currency_id: number;
  fee_percentage: number;
  min_fee_amount?: number | null;
  max_fee_amount?: number | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface FeeCalculationResult {
  originalAmount: number;
  feeAmount: number;
  finalAmount: number;
  feePercentage: number;
}

/**
 * Получает активную комиссию для валюты
 */
export const getActiveFeeForCurrency = async (currencyId: number): Promise<PlatformFee | null> => {
  try {
    const fee = await db("platform_fees")
      .where({ currency_id: currencyId, is_active: true })
      .first();

    return fee || null;
  } catch (error) {
    console.error("Error fetching platform fee:", error);
    return null;
  }
};

/**
 * Получает все активные комиссии
 */
export const getAllActiveFees = async (): Promise<PlatformFee[]> => {
  try {
    const fees = await db("platform_fees").where({ is_active: true }).orderBy("currency_id", "asc");

    return fees;
  } catch (error) {
    console.error("Error fetching all platform fees:", error);
    return [];
  }
};

/**
 * Рассчитывает комиссию для суммы
 */
export const calculateFee = async (
  amount: number,
  currencyId: number
): Promise<FeeCalculationResult> => {
  const fee = await getActiveFeeForCurrency(currencyId);

  if (!fee) {
    // Если комиссия не найдена, возвращаем оригинальную сумму без комиссии
    return {
      originalAmount: amount,
      feeAmount: 0,
      finalAmount: amount,
      feePercentage: 0,
    };
  }

  // Рассчитываем комиссию
  let feeAmount = (amount * fee.fee_percentage) / 100;

  // Применяем минимальную комиссию если указана
  if (fee.min_fee_amount && feeAmount < fee.min_fee_amount) {
    feeAmount = fee.min_fee_amount;
  }

  // Применяем максимальную комиссию если указана
  if (fee.max_fee_amount && feeAmount > fee.max_fee_amount) {
    feeAmount = fee.max_fee_amount;
  }

  // Округляем до 2 знаков после запятой
  feeAmount = Math.round(feeAmount * 100) / 100;
  const finalAmount = Math.round((amount - feeAmount) * 100) / 100;

  return {
    originalAmount: amount,
    feeAmount,
    finalAmount,
    feePercentage: fee.fee_percentage,
  };
};

/**
 * Создает новую комиссию
 */
export const createPlatformFee = async (feeData: {
  currency_id: number;
  fee_percentage: number;
  min_fee_amount?: number | null;
  max_fee_amount?: number | null;
}): Promise<PlatformFee> => {
  try {
    return await db.transaction(async (trx) => {
      // Деактивируем существующую комиссию для этой валюты
      await trx("platform_fees")
        .where({ currency_id: feeData.currency_id, is_active: true })
        .update({ is_active: false, updated_at: trx.fn.now() });

      // Создаем новую активную комиссию
      const [newFee] = await trx("platform_fees")
        .insert({
          ...feeData,
          is_active: true,
          created_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning("*");

      return newFee;
    });
  } catch (error) {
    console.error("Error creating platform fee:", error);
    throw error;
  }
};

/**
 * Обновляет комиссию
 */
export const updatePlatformFee = async (
  feeId: number,
  updateData: {
    fee_percentage?: number;
    min_fee_amount?: number | null;
    max_fee_amount?: number | null;
    is_active?: boolean;
  }
): Promise<PlatformFee | null> => {
  try {
    const [updatedFee] = await db("platform_fees")
      .where({ id: feeId })
      .update({
        ...updateData,
        updated_at: db.fn.now(),
      })
      .returning("*");

    return updatedFee || null;
  } catch (error) {
    console.error("Error updating platform fee:", error);
    throw error;
  }
};

/**
 * Получает историю комиссий для валюты
 */
export const getFeeHistoryForCurrency = async (currencyId: number): Promise<PlatformFee[]> => {
  try {
    const fees = await db("platform_fees")
      .where({ currency_id: currencyId })
      .orderBy("created_at", "desc");

    return fees;
  } catch (error) {
    console.error("Error fetching fee history:", error);
    return [];
  }
};
