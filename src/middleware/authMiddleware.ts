import { Request, Response, NextFunction } from "express";

import { ERROR_CODES } from "../utils/errorCodes";
import { verifyAccessToken } from "../utils/jwt";

const createAuthMiddleware = (options?: { optional?: boolean }) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      if (options?.optional) {
        return next();
      }
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

    const userId = Number(decoded.payload?.userId);
    if (!userId) {
      return res.status(401).json({
        error: {
          code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN,
          message: "Invalid token payload",
        },
      });
    }

    req.auth = { userId };
    next();
  };
};

export const authMiddleware = createAuthMiddleware();
export const optionalAuthMiddleware = createAuthMiddleware({ optional: true });
