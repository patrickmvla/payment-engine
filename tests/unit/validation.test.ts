import { describe, expect, it } from "bun:test";
import { AuthorizeSchema, CaptureSchema, RefundSchema } from "../../src/payments/schemas";

// ─────────────────────────────────────────────────────────────
// 4a. AuthorizeSchema — Valid Requests
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Valid Requests", () => {
  it("minimum valid request (amount + currency)", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1,
      currency: "USD",
    });
    expect(result.success).toBe(true);
  });

  it("all optional fields present", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 10000,
      currency: "USD",
      description: "Order #12345",
      metadata: { order_id: "ord_abc", customer_email: "user@example.com" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Order #12345");
      expect(result.data.metadata).toEqual({
        order_id: "ord_abc",
        customer_email: "user@example.com",
      });
    }
  });

  it("maximum valid amount", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 99999999,
      currency: "USD",
    });
    expect(result.success).toBe(true);
  });

  it("multiple valid currencies", () => {
    for (const currency of ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"]) {
      const result = AuthorizeSchema.safeParse({ amount: 1000, currency });
      expect(result.success).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 4b. Invalid Amounts
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Invalid Amounts", () => {
  it("rejects zero amount", () => {
    expect(AuthorizeSchema.safeParse({ amount: 0, currency: "USD" }).success).toBe(false);
  });

  it("rejects negative amount", () => {
    expect(AuthorizeSchema.safeParse({ amount: -100, currency: "USD" }).success).toBe(false);
  });

  it("rejects float amount (no fractional cents)", () => {
    expect(AuthorizeSchema.safeParse({ amount: 10.5, currency: "USD" }).success).toBe(false);
  });

  it("rejects amount exceeding max", () => {
    expect(AuthorizeSchema.safeParse({ amount: 100_000_000_000, currency: "USD" }).success).toBe(
      false,
    );
  });

  it("rejects string amount", () => {
    expect(AuthorizeSchema.safeParse({ amount: "10000", currency: "USD" }).success).toBe(false);
  });

  it("rejects NaN", () => {
    expect(AuthorizeSchema.safeParse({ amount: NaN, currency: "USD" }).success).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(AuthorizeSchema.safeParse({ amount: Infinity, currency: "USD" }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4c. Invalid Currencies
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Invalid Currencies", () => {
  it("rejects lowercase", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "usd" }).success).toBe(false);
  });

  it("rejects wrong length (2 chars)", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "US" }).success).toBe(false);
  });

  it("rejects wrong length (4 chars)", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "USDD" }).success).toBe(false);
  });

  it("rejects numeric string", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "123" }).success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "" }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4d. Adversarial Inputs
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Adversarial Inputs", () => {
  it("rejects SQL injection in currency field", () => {
    expect(
      AuthorizeSchema.safeParse({
        amount: 1000,
        currency: "'; DROP TABLE payments;--",
      }).success,
    ).toBe(false);
  });

  it("rejects __proto__ key in metadata", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      metadata: { __proto__: { admin: true } },
    });
    // Must either reject or strip the __proto__ key
    if (result.success) {
      expect((result.data.metadata as any).__proto__).toBeUndefined();
    }
  });

  it("rejects constructor pollution in metadata", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      metadata: { constructor: { prototype: { admin: true } } },
    });
    if (result.success) {
      expect((result.data.metadata as any).constructor).toBeUndefined();
    }
  });

  it("rejects metadata with more than 10 keys", () => {
    const metadata: Record<string, string> = {};
    for (let i = 0; i < 11; i++) {
      metadata[`key_${i}`] = `value_${i}`;
    }
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "USD", metadata }).success).toBe(
      false,
    );
  });

  it("rejects nested objects in metadata", () => {
    expect(
      AuthorizeSchema.safeParse({
        amount: 1000,
        currency: "USD",
        metadata: { nested: { deep: "value" } },
      }).success,
    ).toBe(false);
  });

  it("rejects array values in metadata", () => {
    expect(
      AuthorizeSchema.safeParse({
        amount: 1000,
        currency: "USD",
        metadata: { tags: ["a", "b"] },
      }).success,
    ).toBe(false);
  });

  it("rejects Cyrillic confusable currency code", () => {
    expect(AuthorizeSchema.safeParse({ amount: 1000, currency: "\u0423SD" }).success).toBe(false);
  });

  it("rejects description exceeding 500 characters", () => {
    expect(
      AuthorizeSchema.safeParse({
        amount: 1000,
        currency: "USD",
        description: "x".repeat(501),
      }).success,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4e. Mass Assignment Protection
// ─────────────────────────────────────────────────────────────

describe("AuthorizeSchema — Mass Assignment Protection", () => {
  it("strips status field", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      status: "captured",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).status).toBeUndefined();
    }
  });

  it("strips id field", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      id: "pay_malicious",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).id).toBeUndefined();
    }
  });

  it("strips refunded_amount field", () => {
    const result = AuthorizeSchema.safeParse({
      amount: 1000,
      currency: "USD",
      refunded_amount: 9999,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).refunded_amount).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 4f. CaptureSchema
// ─────────────────────────────────────────────────────────────

describe("CaptureSchema", () => {
  it("accepts empty body (full capture)", () => {
    const result = CaptureSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts partial capture amount", () => {
    const result = CaptureSchema.safeParse({ amount: 5000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(5000);
    }
  });

  it("rejects zero capture amount", () => {
    expect(CaptureSchema.safeParse({ amount: 0 }).success).toBe(false);
  });

  it("rejects negative capture amount", () => {
    expect(CaptureSchema.safeParse({ amount: -100 }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4g. RefundSchema
// ─────────────────────────────────────────────────────────────

describe("RefundSchema", () => {
  it("accepts empty body (full refund)", () => {
    const result = RefundSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts partial refund amount", () => {
    const result = RefundSchema.safeParse({ amount: 3000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(3000);
    }
  });

  it("accepts refund with reason", () => {
    const result = RefundSchema.safeParse({
      amount: 3000,
      reason: "Customer returned item",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe("Customer returned item");
    }
  });

  it("rejects reason exceeding 500 characters", () => {
    expect(RefundSchema.safeParse({ amount: 3000, reason: "x".repeat(501) }).success).toBe(false);
  });
});
