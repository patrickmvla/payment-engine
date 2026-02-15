import type { ErrorHandler } from "hono";
import { InvalidStateTransitionError as StateMachineError } from "../../payments/state-machine";
import { AppError } from "../errors";
import { logger } from "../logger";

export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = c.get("requestId") as string | undefined;

  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode as any);
  }

  // State machine throws its own InvalidStateTransitionError (not AppError)
  if (err instanceof StateMachineError) {
    return c.json(
      {
        error: {
          type: "invalid_state_transition",
          message: err.message,
          details: {
            current_status: err.from,
            attempted_action: err.to,
            allowed_actions: err.allowedTransitions,
          },
        },
      },
      409,
    );
  }

  // Hono validation errors (from zod-openapi)
  if (err.name === "ZodError" || ("getResponse" in err && typeof err.getResponse === "function")) {
    return c.json(
      {
        error: {
          type: "validation_error",
          message: "Request validation failed",
        },
      },
      400,
    );
  }

  logger.error({ error: err.message, stack: err.stack, requestId }, "Unhandled error");

  return c.json(
    {
      error: {
        type: "internal_error",
        message: "An unexpected error occurred",
      },
    },
    500,
  );
};
