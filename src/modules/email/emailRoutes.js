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
import { authenticate } from '../../middlewares/auth.js';

const router = Router();

// Google OAuth 2.0 Initiation & Callback Routes
router.get('/oauth/google', initiateGoogleOAuthController);
router.get('/oauth/google/callback', googleOAuthCallbackController);

// Microsoft Identity Platform OAuth 2.0 Initiation & Callback Routes
router.get('/oauth/microsoft', initiateMicrosoftOAuthController);
router.get('/oauth/microsoft/callback', microsoftOAuthCallbackController);

const resolveEmailAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }
  if (process.env.NODE_ENV === 'test' && req.headers['x-hotel-id']) {
    req.user = { hotelId: req.headers['x-hotel-id'], role: 'manager' };
    return next();
  }
  return res.status(401).json({ success: false, message: 'Authentication required. Missing or invalid Bearer token.', data: null });
};

// Gmail & Microsoft Inbox Synchronization (Authenticated)
router.post('/sync', resolveEmailAuth, syncGmailController);
router.post('/sync/microsoft', resolveEmailAuth, syncMicrosoftController);

// Test mail server connection (IMAP / SMTP socket handshake or Microsoft Graph)
router.post('/test-connection', resolveEmailAuth, testConnectionController);
router.post('/test-connection/microsoft', resolveEmailAuth, testMicrosoftConnectionController);

// Inbound email receiver (Webhook from email gateway / IMAP fetcher)
router.post('/inbound', inboundEmailController);

// Outbound email dispatcher (Authenticated)
router.post('/send', resolveEmailAuth, sendEmailController);

export default router;

