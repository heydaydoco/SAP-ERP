import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.warn(`[api] listening on :${port}`);
}

void bootstrap();
