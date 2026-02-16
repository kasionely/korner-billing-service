import { getUserPaymentTokens } from "../../models/token.model";

export const cardService = {
  async getUserCards(userId: number) {
    return getUserPaymentTokens(userId);
  },
};
