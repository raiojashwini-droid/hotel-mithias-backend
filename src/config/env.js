import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('FATAL: JWT_SECRET environment variable is required in production.'); })() : 'hotelogx_connect_jwt_secret_key_2026'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
  microsoftTenantId: process.env.MICROSOFT_TENANT_ID || 'common',
  microsoftRedirectUri: process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:5000/api/email/oauth/microsoft/callback',
  microsoftGraphBaseUrl: process.env.MICROSOFT_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0',
};
