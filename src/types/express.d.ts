declare namespace Express {
  interface Request {
    auth?: {
      userId: number;
    };
  }
}
