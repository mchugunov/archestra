export function getImageUpdateFailure(
  error: unknown,
  fallbackCategory: string,
): {
  errorCategory: string;
  errorMessage: string;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (isTimeoutError(error, rawMessage)) {
    return {
      errorCategory: "timeout",
      errorMessage: "Image update check timed out.",
    };
  }

  return {
    errorCategory: getErrorCategory(error, fallbackCategory),
    errorMessage: sanitizeImageUpdateErrorMessage(rawMessage),
  };
}

export function getImageUpdateErrorLogFields(error: unknown): {
  errorClass: string;
  errorMessage: string;
} {
  if (error instanceof Error) {
    return {
      errorClass: error.name || error.constructor.name,
      errorMessage: sanitizeImageUpdateErrorMessage(error.message),
    };
  }

  return {
    errorClass: typeof error,
    errorMessage: sanitizeImageUpdateErrorMessage(String(error)),
  };
}

// ===== Internal helpers =====

function getErrorCategory(error: unknown, fallbackCategory: string): string {
  if (!(error instanceof Error)) {
    return fallbackCategory;
  }

  const normalized = normalizeErrorCategory(
    error.name || error.constructor.name,
  );
  return normalized === "error" ? fallbackCategory : normalized;
}

function isTimeoutError(error: unknown, rawMessage: string): boolean {
  return (
    (error instanceof Error && /timeout/i.test(error.name)) ||
    /timeout|timed out/i.test(rawMessage)
  );
}

function normalizeErrorCategory(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  return normalized || "check_failed";
}

function sanitizeImageUpdateErrorMessage(message: string): string {
  const sanitized = message
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(
      /([?&](?:access_token|api_key|apikey|password|refresh_token|secret|token)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/:\/\/[^:/\s]+:[^@\s]+@/g, "://[redacted]@")
    .replace(
      /(authorization|api[-_]?key|password|secret|token)\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) {
    return "Image update check failed.";
  }

  if (sanitized.length <= MAX_SAFE_ERROR_MESSAGE_LENGTH) {
    return sanitized;
  }

  return `${sanitized.slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH - 3)}...`;
}

const MAX_SAFE_ERROR_MESSAGE_LENGTH = 240;
