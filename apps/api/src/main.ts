import './load-env.js';
import 'reflect-metadata';
import { API_PREFIX, apiEnvSchema, parseEnv, PORTS } from '@integris/shared';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

async function bootstrap() {
  const env = parseEnv(apiEnvSchema, process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // Nginx on the same host is the only proxy in front of the API.
  app.set('trust proxy', 'loopback');
  configureApp(app);
  app.enableShutdownHooks();

  if (env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder().setTitle('Integris LaTeX API').setVersion('0.0.0').build();
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(PORTS.api, '127.0.0.1');
}

void bootstrap();
