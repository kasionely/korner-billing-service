import jwt, { TokenExpiredError } from "jsonwebtoken";

import { ERROR_CODES } from "./errorCodes";

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

export interface TokenPayload {
  userId: string;
  email: string;
}

export const generateTokens = (payload: TokenPayload) => {
  if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
    throw new Error("Both ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET are required");
  }

  if (ACCESS_TOKEN_SECRET === REFRESH_TOKEN_SECRET) {
    console.warn("Access and refresh token secrets should not be the same!");
  }

  const accessToken = jwt.sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: "24h" });
  const refreshToken = jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: "30d" });

  return { accessToken, refreshToken };
};

type ErrorMessage = {
  code: string;
  message: string;
};

export const verifyAccessToken = (
  token: string
): { payload?: TokenPayload; error?: ErrorMessage } => {
  if (!ACCESS_TOKEN_SECRET) {
    throw new Error("ACCESS_TOKEN_SECRET are required");
  }

  try {
    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET) as TokenPayload;
    return { payload };
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      return { error: { code: ERROR_CODES.BASE_TOKEN_EXPIRED, message: "Token has expired" } };
    }
    return { error: { code: ERROR_CODES.BASE_INVALID_ACCESS_TOKEN, message: "Invalid token" } };
  }
};

export const verifyRefreshToken = (token: string) => {
  if (!REFRESH_TOKEN_SECRET) {
    throw new Error("REFRESH_TOKEN_SECRET are required");
  }

  return jwt.verify(token, REFRESH_TOKEN_SECRET) as TokenPayload;
};
