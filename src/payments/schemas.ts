import { z } from "zod";

const MetadataSchema = z
  .any()
  .refine(
    (val) => {
      if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
      if (Object.getPrototypeOf(val) !== Object.prototype) return false;
      const keys = Object.keys(val);
      if (keys.length > 10) return false;
      return keys.every((key) => typeof val[key] === "string");
    },
    { message: "Invalid metadata: must be a flat object with string values (max 10 keys)" },
  )
  .transform((val) => val as Record<string, string>);

export const AuthorizeSchema = z.object({
  amount: z.number().int().positive().max(99999999),
  currency: z.string().regex(/^[A-Z]{3}$/),
  description: z.string().max(500).optional(),
  metadata: MetadataSchema.optional(),
});

export const CaptureSchema = z.object({
  amount: z.number().int().positive().optional(),
});

export const RefundSchema = z.object({
  amount: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
});
