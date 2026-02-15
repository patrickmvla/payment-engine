import { describe, expect, it } from "bun:test";
import {
  getValidTransitions,
  InvalidStateTransitionError,
  type PaymentStatus,
  TERMINAL_STATES,
  validateTransition,
} from "../../src/payments/state-machine";

const STATES: PaymentStatus[] = [
  "created",
  "authorized",
  "captured",
  "settled",
  "voided",
  "expired",
  "refunded",
  "partially_refunded",
];

// ─────────────────────────────────────────────────────────────
// 2a. Full 8×8 Transition Matrix
// 12 valid cells, 52 invalid. Single source of truth.
// ─────────────────────────────────────────────────────────────

describe("State Machine — 8×8 Transition Matrix", () => {
  const VALID: Record<PaymentStatus, Record<PaymentStatus, boolean>> = {
    created: {
      created: false,
      authorized: true,
      captured: false,
      settled: false,
      voided: false,
      expired: true,
      refunded: false,
      partially_refunded: false,
    },
    authorized: {
      created: false,
      authorized: false,
      captured: true,
      settled: false,
      voided: true,
      expired: true,
      refunded: false,
      partially_refunded: false,
    },
    captured: {
      created: false,
      authorized: false,
      captured: false,
      settled: true,
      voided: false,
      expired: false,
      refunded: true,
      partially_refunded: true,
    },
    settled: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: true,
      partially_refunded: true,
    },
    voided: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: false,
      partially_refunded: false,
    },
    expired: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: false,
      partially_refunded: false,
    },
    refunded: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: false,
      partially_refunded: false,
    },
    partially_refunded: {
      created: false,
      authorized: false,
      captured: false,
      settled: false,
      voided: false,
      expired: false,
      refunded: true,
      partially_refunded: true,
    },
  };

  for (const from of STATES) {
    for (const to of STATES) {
      const expected = VALID[from][to];
      it(`${from} → ${to} is ${expected ? "VALID" : "INVALID"}`, () => {
        if (expected) {
          expect(() => validateTransition(from, to)).not.toThrow();
        } else {
          expect(() => validateTransition(from, to)).toThrow(InvalidStateTransitionError);
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────
// 2b. getValidTransitions — exact arrays per state
// ─────────────────────────────────────────────────────────────

describe("State Machine — getValidTransitions", () => {
  it("created → [authorized, expired]", () => {
    const valid = getValidTransitions("created");
    expect(valid).toContain("authorized");
    expect(valid).toContain("expired");
    expect(valid).toHaveLength(2);
  });

  it("authorized → [captured, voided, expired]", () => {
    const valid = getValidTransitions("authorized");
    expect(valid).toContain("captured");
    expect(valid).toContain("voided");
    expect(valid).toContain("expired");
    expect(valid).toHaveLength(3);
  });

  it("captured → [settled, refunded, partially_refunded]", () => {
    const valid = getValidTransitions("captured");
    expect(valid).toContain("settled");
    expect(valid).toContain("refunded");
    expect(valid).toContain("partially_refunded");
    expect(valid).toHaveLength(3);
  });

  it("settled → [refunded, partially_refunded]", () => {
    const valid = getValidTransitions("settled");
    expect(valid).toContain("refunded");
    expect(valid).toContain("partially_refunded");
    expect(valid).toHaveLength(2);
  });

  it("partially_refunded → [refunded, partially_refunded]", () => {
    const valid = getValidTransitions("partially_refunded");
    expect(valid).toContain("refunded");
    expect(valid).toContain("partially_refunded");
    expect(valid).toHaveLength(2);
  });

  it("voided → [] (terminal)", () => {
    expect(getValidTransitions("voided")).toEqual([]);
  });

  it("expired → [] (terminal)", () => {
    expect(getValidTransitions("expired")).toEqual([]);
  });

  it("refunded → [] (terminal)", () => {
    expect(getValidTransitions("refunded")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 2c. Terminal States Export
// ─────────────────────────────────────────────────────────────

describe("State Machine — Terminal States", () => {
  it("TERMINAL_STATES is exactly {voided, expired, refunded}", () => {
    const expected = new Set(["voided", "expired", "refunded"]);
    const actual = new Set(TERMINAL_STATES);
    expect(actual).toEqual(expected);
    expect(TERMINAL_STATES).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────
// 2d. Error Diagnostics
// ─────────────────────────────────────────────────────────────

describe("State Machine — Error Diagnostics", () => {
  it("InvalidStateTransitionError is an instance of Error", () => {
    try {
      validateTransition("created", "captured");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("error carries .from property", () => {
    try {
      validateTransition("created", "captured");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as InvalidStateTransitionError).from).toBe("created");
    }
  });

  it("error carries .to property", () => {
    try {
      validateTransition("created", "captured");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as InvalidStateTransitionError).to).toBe("captured");
    }
  });

  it("error carries .allowedTransitions array", () => {
    try {
      validateTransition("created", "captured");
      expect.unreachable("should have thrown");
    } catch (err) {
      const allowed = (err as InvalidStateTransitionError).allowedTransitions;
      expect(Array.isArray(allowed)).toBe(true);
      expect(allowed).toContain("authorized");
      expect(allowed).toContain("expired");
    }
  });

  it("error .message is human-readable and includes context", () => {
    try {
      validateTransition("settled", "authorized");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as InvalidStateTransitionError).message;
      expect(msg).toContain("settled");
      expect(msg).toContain("authorized");
      expect(msg.length).toBeGreaterThan(10);
    }
  });
});
