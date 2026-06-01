import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Unified error envelope for the whole API (root CLAUDE.md §4: one error format). Every error
 * becomes `{ error: { status, path, ...detail }, timestamp }`. Unexpected (non-HTTP) errors are
 * logged and reported as 500 without leaking internals.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = isHttp ? exception.getResponse() : { message: 'Internal server error' };
    const detail = typeof raw === 'string' ? { message: raw } : raw;

    if (!isHttp) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(status).json({
      error: { status, path: req.url, ...detail },
      timestamp: new Date().toISOString(),
    });
  }
}
