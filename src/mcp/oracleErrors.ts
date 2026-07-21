export enum ErrorCode {
  // Validation
  INVALID_REQUEST = "INVALID_REQUEST",
  INVALID_SKILL = "INVALID_SKILL",
  INVALID_FILE_PATTERN = "INVALID_FILE_PATTERN",
  INVALID_MEMORY_TYPE = "INVALID_MEMORY_TYPE",
  INVALID_ORACLE_PROFILE = "INVALID_ORACLE_PROFILE",
  PROFILE_NOT_FOUND = "PROFILE_NOT_FOUND",

  // State
  NO_FILES = "NO_FILES",
  NO_MEMORY_ENTRIES = "NO_MEMORY_ENTRIES",
  NOT_FOUND = "NOT_FOUND",
  ALREADY_EXISTS = "ALREADY_EXISTS",

  // Execution
  PROVIDER_ERROR = "PROVIDER_ERROR",
  PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE",
  CONSULT_FAILED = "CONSULT_FAILED",
  FILE_READ_ERROR = "FILE_READ_ERROR",
  MEMORY_STORE_ERROR = "MEMORY_STORE_ERROR",

  // Configuration
  CONFIG_INVALID = "CONFIG_INVALID",
  IDENTITY_NOT_SET = "IDENTITY_NOT_SET",
}

export interface OracleErrorMeta {
  code: ErrorCode;
  message: string;
  detail?: string;
  context?: Record<string, any>;
}

export class OracleToolError extends Error implements OracleErrorMeta {
  code: ErrorCode;
  message: string;
  detail?: string;
  context?: Record<string, any>;

  constructor(code: ErrorCode, message: string, detail?: string, context?: Record<string, any>) {
    super(message);
    this.code = code;
    this.message = message;
    this.detail = detail;
    this.context = context;
    this.name = "OracleToolError";
  }

  toJSON(): OracleErrorMeta {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      context: this.context,
    };
  }
}

export function isOracleError(error: unknown): error is OracleToolError {
  return error instanceof OracleToolError;
}
