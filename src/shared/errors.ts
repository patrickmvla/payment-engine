export class AppError extends Error {
  readonly type: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    type: string,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.type = type;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class PaymentNotFoundError extends AppError {
  constructor(paymentId: string) {
    super("not_found", `Payment ${paymentId} not found`, 404, {
      payment_id: paymentId,
    });
    this.name = "PaymentNotFoundError";
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(paymentId: string, currentStatus: string, attemptedAction: string) {
    super(
      "invalid_state_transition",
      `Cannot ${attemptedAction} a payment with status '${currentStatus}'`,
      409,
      {
        payment_id: paymentId,
        current_status: currentStatus,
        attempted_action: attemptedAction,
      },
    );
    this.name = "InvalidStateTransitionError";
  }
}

export class InvalidAmountError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("invalid_amount", message, 422, details);
    this.name = "InvalidAmountError";
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(key: string) {
    super(
      "idempotency_conflict",
      `Idempotency key '${key}' has already been used with different parameters`,
      409,
      { idempotency_key: key },
    );
    this.name = "IdempotencyConflictError";
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("insufficient_funds", message, 422, details);
    this.name = "InsufficientFundsError";
  }
}

export class LedgerImbalanceError extends AppError {
  constructor(transactionId: string, debits: bigint, credits: bigint) {
    super(
      "ledger_imbalance",
      `Transaction ${transactionId} is unbalanced: debits=${debits}, credits=${credits}`,
      500,
      {
        transaction_id: transactionId,
        total_debits: debits.toString(),
        total_credits: credits.toString(),
      },
    );
    this.name = "LedgerImbalanceError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_error", message, 400, details);
    this.name = "ValidationError";
  }
}
