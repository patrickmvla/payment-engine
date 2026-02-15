import type { PaymentStatus } from "./state-machine";

export interface AuthorizeParams {
  amount: bigint;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface CaptureParams {
  amount?: bigint;
}

export interface RefundParams {
  amount?: bigint;
  reason?: string;
}

export interface PaymentRecord {
  id: string;
  status: PaymentStatus;
  amount: bigint;
  currency: string;
  authorizedAmount: bigint;
  capturedAmount: bigint;
  refundedAmount: bigint;
  description: string | null;
  metadata: Record<string, string> | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

export interface ListPaymentsOptions {
  limit?: number;
  cursor?: string;
  status?: PaymentStatus;
}

export interface PaginatedResponse<T> {
  data: T[];
  hasMore: boolean;
  nextCursor?: string;
}
