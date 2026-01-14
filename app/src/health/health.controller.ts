import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly healthService: HealthService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Check service health and database connection (readiness probe)',
  })
  @ApiResponse({
    status: 200,
    description: 'Service is healthy and database is connected',
  })
  @ApiResponse({
    status: 503,
    description: 'Service is unhealthy or database is not connected',
  })
  async check(@Res() response: Response) {
    const healthStatus = await this.healthService.getOverallHealth();

    if (healthStatus.status === 'error') {
      const downServices = healthStatus.services.filter(
        (s: { status: string }) => s.status === 'down',
      );
      const errorResponse = {
        status: 'error',
        info: {},
        error: downServices.reduce(
          (acc, service) => {
            acc[service.name] = {
              status: 'down',
              message: service.message || 'Service unavailable',
            };
            return acc;
          },
          {} as Record<string, { status: string; message?: string }>,
        ),
        details: healthStatus.services.reduce(
          (acc, service) => {
            acc[service.name] = {
              status: service.status,
              message: service.message,
              responseTime: service.responseTime
                ? `${service.responseTime}ms`
                : undefined,
            };
            return acc;
          },
          {} as Record<string, any>,
        ),
      };
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json(errorResponse);
    }

    const successResponse = {
      status: 'ok',
      info: healthStatus.services.reduce(
        (acc, service) => {
          acc[service.name] = {
            status: 'up',
            responseTime: service.responseTime
              ? `${service.responseTime}ms`
              : undefined,
          };
          return acc;
        },
        {} as Record<string, any>,
      ),
      error: {},
      details: healthStatus.services.reduce(
        (acc, service) => {
          acc[service.name] = {
            status: service.status,
            message: service.message,
            responseTime: service.responseTime
              ? `${service.responseTime}ms`
              : undefined,
          };
          return acc;
        },
        {} as Record<string, any>,
      ),
    };
    return response.status(HttpStatus.OK).json(successResponse);
  }

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe - checks if service is running (no DB check)',
  })
  @ApiResponse({
    status: 200,
    description: 'Service is alive',
  })
  liveness() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe - checks if service and database are ready',
  })
  @ApiResponse({
    status: 200,
    description: 'Service is ready (database connected)',
  })
  @ApiResponse({
    status: 503,
    description: 'Service is not ready (database not connected)',
  })
  async readiness(@Res() response: Response) {
    const dbStatus = await this.healthService.checkDatabase();

    if (dbStatus.status === 'down') {
      const errorResponse = {
        status: 'error',
        info: {},
        error: {
          database: {
            status: 'down',
            message: dbStatus.message || 'Database connection failed',
          },
        },
        details: {
          database: {
            status: 'down',
            message: dbStatus.message || 'Database connection failed',
          },
        },
      };
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json(errorResponse);
    }

    const successResponse = {
      status: 'ok',
      info: {
        database: {
          status: 'up',
          responseTime: dbStatus.responseTime
            ? `${dbStatus.responseTime}ms`
            : undefined,
        },
      },
      error: {},
      details: {
        database: {
          status: 'up',
          responseTime: dbStatus.responseTime
            ? `${dbStatus.responseTime}ms`
            : undefined,
        },
      },
    };
    return response.status(HttpStatus.OK).json(successResponse);
  }
}
