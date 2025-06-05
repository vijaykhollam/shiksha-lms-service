import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseTransformerInterceptor } from './common/interceptors/response-transformer.interceptor';
import { ConfigService } from '@nestjs/config';

// Added code for login 
async function bootstrap() {
  try {
    
    // Now we can connect to our target database
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);
    const port = configService.get('PORT', 4000);
    
    // Set global prefix
    app.setGlobalPrefix(configService.get('API_PREFIX', 'api/v1'));
    
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
    
    // Start the application
    await app.listen(port, '0.0.0.0');
    console.log(`Application is running on: http://localhost:${port}`);
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap();