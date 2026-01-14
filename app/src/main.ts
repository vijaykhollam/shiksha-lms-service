import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseTransformerInterceptor } from './common/interceptors/response-transformer.interceptor';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigurationService } from './configuration/configuration.service';

async function bootstrap() {
  try {
    
    // Now we can connect to our target database
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);
    const port = configService.get('PORT', 4000);
    
    // Set global prefix (exclude health endpoints)
    app.setGlobalPrefix(configService.get('API_PREFIX', 'api/v1'), {
      exclude: [
        { path: 'health', method: RequestMethod.GET },
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    
    // Enable CORS
    app.enableCors();
    
    // Set global pipes
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
        transformOptions: {
          enableImplicitConversion: true,
        },
      }),
    );
    
    // Set global filters
    const reflector = app.get(Reflector);
    app.useGlobalFilters(new HttpExceptionFilter(reflector));
    
    // Set global interceptors
    app.useGlobalInterceptors(new ResponseTransformerInterceptor(reflector));
    
    // --- Swagger setup ---
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Shiksha LMS API')
      .setDescription('API documentation for Shiksha LMS Service')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
    // --- End Swagger setup ---

    const configurationService = app.get(ConfigurationService);
    await configurationService.syncTenantConfig(configService.get("TENANT_ID") || "");

    // Start the application
    await app.listen(port, '0.0.0.0');
    console.log(`Application is running on port:${port}`);
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap();