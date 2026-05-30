import type { Request, Response, NextFunction } from "express";

interface HttpError extends Error {
  statusCode?: number;
  status?: number;
}

const errorHandler = (err: HttpError, _req: Request, res: Response, _next: NextFunction): void => {
  const statusCode = err.statusCode ?? err.status ?? 500;
  console.error(`Error [${statusCode}]:`, err.message);
  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal server error.",
  });
};

export default errorHandler;