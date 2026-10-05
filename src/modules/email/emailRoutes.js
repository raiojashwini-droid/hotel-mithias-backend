import { Router } from 'express';
import {
  initiateGoogleOAuthController,
  googleOAuthCallbackController,
  testConnectionController,
  inboundEmailController,
  sendEmailController,
  syncGmailController,
  initiateMicrosoftOAuthController,
  microsoftOAuthCallbackController,
  syncMicrosoftController,
  testMicrosoftConnectionController,
} from './emailController.js';

const router = Router();

// Google OAuth 2.0 Initiation & Callback Routes
router.get('/oauth/google', initiateGoogleOAuthController);
router.get('/oauth/google/callback', googleOAuthCallbackController);

// Microsoft Identity Platform OAuth 2.0 Initiation & Callback Routes
router.get('/oauth/microsoft', initiateMicrosoftOAuthController);
router.get('/oauth/microsoft/callback', microsoftOAuthCallbackController);

// Gmail & Microsoft Inbox Synchronization
router.post('/sync', syncGmailController);
router.post('/sync/microsoft', syncMicrosoftController);

// Test mail server connection (IMAP / SMTP socket handshake or Microsoft Graph)
router.post('/test-connection', testConnectionController);
router.post('/test-connection/microsoft', testMicrosoftConnectionController);

// Inbound email receiver (Webhook from email gateway / IMAP fetcher)
router.post('/inbound', inboundEmailController);

// Outbound email dispatcher
router.post('/send', sendEmailController);

export default router;

