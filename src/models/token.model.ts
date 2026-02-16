import { db } from "../db";

export type CreateTokenBody = {
  userId: number;
  token: string;
  expired_at?: Date | string;
  amount?: number;
  pan_masked?: string;
};

export const createToken = async (body: CreateTokenBody) => {
  const { userId, token, expired_at, amount, pan_masked } = body;

  try {
    const [newToken] = await db("payment_tokens")
      .insert({
        user_id: userId,
        token,
        expired_at: expired_at ? new Date(expired_at) : null,
        amount,
        pan_masked,
        created_at: new Date(),
      })
      .returning(["id", "user_id", "token", "expired_at", "amount", "pan_masked", "created_at"]);

    return newToken;
  } catch (error) {
    console.error("Error creating token:", error);
    throw new Error("Failed to create payment token");
  }
};

export const getUserPaymentTokens = async (userId: number) => {
  try {
    const tokens = await db("payment_tokens")
      .where({ user_id: userId })
      .select(["id", "pan_masked", "amount", "expired_at", "created_at"])
      .orderBy("created_at", "desc");

    return tokens;
  } catch (error) {
    console.error("Error getting user payment tokens:", error);
    throw new Error("Failed to get user payment tokens");
  }
};

export const getPaymentTokenById = async (tokenId: number, userId: number) => {
  try {
    const token = await db("payment_tokens")
      .where({ id: tokenId, user_id: userId })
      .select(["id", "user_id", "token", "expired_at", "amount", "pan_masked", "created_at"])
      .first();

    return token || null;
  } catch (error) {
    console.error("Error getting payment token by ID:", error);
    throw new Error("Failed to get payment token");
  }
};
