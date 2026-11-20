/** API error carrying an HTTP status and a machine-readable decision code. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, msg: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, msg, details);
export const unauthorized = (msg = "authentication required") => new ApiError(401, "unauthorized", msg);
export const forbidden = (code: string, msg: string, details?: Record<string, unknown>) =>
  new ApiError(403, code, msg, details);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, msg: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, msg, details);
export const unprocessable = (code: string, msg: string, details?: Record<string, unknown>) =>
  new ApiError(422, code, msg, details);
