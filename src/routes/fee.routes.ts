import { Router, Request, Response } from "express";

import { authMiddleware } from "../middleware/authMiddleware";
import {
  getActiveFeeForCurrency,
  getAllActiveFees,
  calculateFee,
  createPlatformFee,
  updatePlatformFee,
  getFeeHistoryForCurrency,
} from "../models/fee.model";
import { cacheValues } from "../utils/cache";
import { ERROR_CODES } from "../utils/errorCodes";
import { verifyAccessToken } from "../utils/jwt";
import redis from "../utils/redis";

const router = Router();

interface AuthRequest extends Request {
  auth?: { userId: number };
}

/**
 * GET /fee/currency/:currencyId
 * Получить активную комиссию для валюты
 */
router.get("/currency/:currencyId", async (req: Request, res: Response) => {
  try {
    const currencyId = parseInt(req.params.currencyId);

    if (isNaN(currencyId) || currencyId <= 0) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Invalid currency ID",
        },
      });
    }

    // Проверяем кэш в Redis
    const cacheKey = `platform_fee:currency:${currencyId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`Served platform fee from Redis cache: ${cacheKey}`);
      return res.status(200).json(JSON.parse(cached));
    }

    const fee = await getActiveFeeForCurrency(currencyId);

    if (!fee) {
      return res.status(404).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Platform fee not found for this currency",
        },
      });
    }

    const responseData = {
      success: true,
      data: {
        currency_id: fee.currency_id,
        fee_percentage: parseFloat(fee.fee_percentage.toString()),
        min_fee_amount: fee.min_fee_amount ? parseFloat(fee.min_fee_amount.toString()) : null,
        max_fee_amount: fee.max_fee_amount ? parseFloat(fee.max_fee_amount.toString()) : null,
      },
    };

    // Кэшируем результат на сутки
    await redis.setex(cacheKey, cacheValues.day, JSON.stringify(responseData));
    console.log(`Cached platform fee: ${cacheKey}`);

    return res.status(200).json(responseData);
  } catch (error) {
    console.error("Error fetching platform fee:", error);
    return res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to fetch platform fee",
      },
    });
  }
});

/**
 * GET /fee/all
 * Получить все активные комиссии
 */
router.get("/all", async (req: Request, res: Response) => {
  try {
    // Проверяем кэш в Redis
    const cacheKey = "platform_fees:all_active";
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`Served all platform fees from Redis cache: ${cacheKey}`);
      return res.status(200).json(JSON.parse(cached));
    }

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

    // Кэшируем результат на сутки
    await redis.setex(cacheKey, cacheValues.day, JSON.stringify(responseData));
    console.log(`Cached all platform fees: ${cacheKey}`);

    return res.status(200).json(responseData);
  } catch (error) {
    console.error("Error fetching all platform fees:", error);
    return res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to fetch platform fees",
      },
    });
  }
});

/**
 * POST /fee/calculate
 * Рассчитать комиссию для суммы
 */
router.post("/calculate", async (req: Request, res: Response) => {
  try {
    const { amount, currency_id } = req.body;

    if (!amount || !currency_id) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Amount and currency_id are required",
        },
      });
    }

    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Amount must be a positive number",
        },
      });
    }

    if (typeof currency_id !== "number" || currency_id <= 0) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Currency ID must be a positive number",
        },
      });
    }

    const feeCalculation = await calculateFee(amount, currency_id);

    return res.status(200).json({
      success: true,
      data: feeCalculation,
    });
  } catch (error) {
    console.error("Error calculating fee:", error);
    return res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to calculate fee",
      },
    });
  }
});

/**
 * GET /fee/currency/:currencyId/history
 * Получить историю комиссий для валюты (требует авторизации)
 */
router.get(
  "/currency/:currencyId/history",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const currencyId = parseInt(req.params.currencyId);

      if (isNaN(currencyId) || currencyId <= 0) {
        return res.status(400).json({
          error: {
            code: ERROR_CODES.BAD_REQUEST,
            message: "Invalid currency ID",
          },
        });
      }

      // Проверяем кэш в Redis
      const cacheKey = `platform_fee:history:currency:${currencyId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`Served fee history from Redis cache: ${cacheKey}`);
        return res.status(200).json(JSON.parse(cached));
      }

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

      // Кэшируем историю на сутки (изменения редкие)
      await redis.setex(cacheKey, cacheValues.day, JSON.stringify(responseData));
      console.log(`Cached fee history: ${cacheKey}`);

      return res.status(200).json(responseData);
    } catch (error) {
      console.error("Error fetching fee history:", error);
      return res.status(500).json({
        error: {
          code: ERROR_CODES.SERVER_ERROR,
          message: "Failed to fetch fee history",
        },
      });
    }
  }
);

/**
 * POST /fee/create (Админский роут - только для разработки)
 * Создать новую комиссию
 */
router.post("/create", async (req: Request, res: Response) => {
  try {
    // Проверяем токен и права доступа
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({
        error: {
          code: ERROR_CODES.BASE_AUTH_TOKEN_REQUIRED,
          message: "Authorization token required",
        },
      });
    }

    const decoded = verifyAccessToken(token);
    if (decoded.error) {
      return res.status(401).json({
        error: {
          code: decoded.error.code,
          message: decoded.error.message,
        },
      });
    }

    const { currency_id, fee_percentage, min_fee_amount, max_fee_amount } = req.body;

    if (!currency_id || typeof fee_percentage !== "number") {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Currency ID and fee percentage are required",
        },
      });
    }

    if (fee_percentage < 0 || fee_percentage > 100) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Fee percentage must be between 0 and 100",
        },
      });
    }

    const newFee = await createPlatformFee({
      currency_id,
      fee_percentage,
      min_fee_amount: min_fee_amount || null,
      max_fee_amount: max_fee_amount || null,
    });

    return res.status(201).json({
      success: true,
      message: "Platform fee created successfully",
      data: {
        id: newFee.id,
        currency_id: newFee.currency_id,
        fee_percentage: parseFloat(newFee.fee_percentage.toString()),
        min_fee_amount: newFee.min_fee_amount ? parseFloat(newFee.min_fee_amount.toString()) : null,
        max_fee_amount: newFee.max_fee_amount ? parseFloat(newFee.max_fee_amount.toString()) : null,
        is_active: newFee.is_active,
      },
    });
  } catch (error) {
    console.error("Error creating platform fee:", error);
    return res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to create platform fee",
      },
    });
  }
});

/**
 * PUT /fee/:feeId (Админский роут - только для разработки)
 * Обновить комиссию
 */
router.put("/:feeId", async (req: Request, res: Response) => {
  try {
    // Проверяем токен и права доступа
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({
        error: {
          code: ERROR_CODES.BASE_AUTH_TOKEN_REQUIRED,
          message: "Authorization token required",
        },
      });
    }

    const decoded = verifyAccessToken(token);
    if (decoded.error) {
      return res.status(401).json({
        error: {
          code: decoded.error.code,
          message: decoded.error.message,
        },
      });
    }

    const feeId = parseInt(req.params.feeId);
    const { fee_percentage, min_fee_amount, max_fee_amount, is_active } = req.body;

    if (isNaN(feeId) || feeId <= 0) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Invalid fee ID",
        },
      });
    }

    if (fee_percentage !== undefined && (fee_percentage < 0 || fee_percentage > 100)) {
      return res.status(400).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Fee percentage must be between 0 and 100",
        },
      });
    }

    const updatedFee = await updatePlatformFee(feeId, {
      fee_percentage,
      min_fee_amount: min_fee_amount === undefined ? undefined : min_fee_amount || null,
      max_fee_amount: max_fee_amount === undefined ? undefined : max_fee_amount || null,
      is_active,
    });

    if (!updatedFee) {
      return res.status(404).json({
        error: {
          code: ERROR_CODES.BAD_REQUEST,
          message: "Platform fee not found",
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Platform fee updated successfully",
      data: {
        id: updatedFee.id,
        currency_id: updatedFee.currency_id,
        fee_percentage: parseFloat(updatedFee.fee_percentage.toString()),
        min_fee_amount: updatedFee.min_fee_amount
          ? parseFloat(updatedFee.min_fee_amount.toString())
          : null,
        max_fee_amount: updatedFee.max_fee_amount
          ? parseFloat(updatedFee.max_fee_amount.toString())
          : null,
        is_active: updatedFee.is_active,
      },
    });
  } catch (error) {
    console.error("Error updating platform fee:", error);
    return res.status(500).json({
      error: {
        code: ERROR_CODES.SERVER_ERROR,
        message: "Failed to update platform fee",
      },
    });
  }
});

export default router;
