export class RuntimeError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function errorBody(error, stage) {
  return {
    code: error?.code || 'internal_error',
    message: error instanceof Error ? error.message : String(error),
    ...(stage ? { stage } : {}),
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

export function abortError() {
  return new RuntimeError('job_cancelled', '任务已取消', 409);
}
