export class AppError extends Error {
  constructor(
    public code:
      | 'INVALID_INPUT'
      | 'NOT_FOUND'
      | 'RATE_LIMITED'
      | 'MAX_RECEIVERS'
      | 'FORBIDDEN',
    message: string,
    public status: number
  ) {
    super(message);
  }
}

