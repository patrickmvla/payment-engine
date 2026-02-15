export type PaymentStatus =
  | "created"
  | "authorized"
  | "captured"
  | "settled"
  | "voided"
  | "expired"
  | "refunded"
  | "partially_refunded";

const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  created: ["authorized", "expired"],
  authorized: ["captured", "voided", "expired"],
  captured: ["settled", "refunded", "partially_refunded"],
  settled: ["refunded", "partially_refunded"],
  voided: [],
  expired: [],
  refunded: [],
  partially_refunded: ["refunded", "partially_refunded"],
};

export const TERMINAL_STATES: PaymentStatus[] = ["voided", "expired", "refunded"];

export class InvalidStateTransitionError extends Error {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
  readonly allowedTransitions: PaymentStatus[];

  constructor(from: PaymentStatus, to: PaymentStatus, allowedTransitions: PaymentStatus[]) {
    super(
      `Cannot transition from '${from}' to '${to}'. ` +
        `Allowed transitions: [${allowedTransitions.join(", ")}]`,
    );
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
    this.allowedTransitions = allowedTransitions;
  }
}

export function validateTransition(from: PaymentStatus, to: PaymentStatus): PaymentStatus {
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to, allowed);
  }
  return to;
}

export function getValidTransitions(status: PaymentStatus): PaymentStatus[] {
  return [...TRANSITIONS[status]];
}
