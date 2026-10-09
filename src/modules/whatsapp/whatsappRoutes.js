import { Router } from 'express';
import { authenticate, optionalAuth } from '../../middlewares/auth.js';
import {
  getThreads,
  handleAction,
  verifyWebhook,
  handleWebhook,
  sendTestMessage,
  handleEmbeddedSignupExchange,
  handleOAuthCallback,
  handleManualConnect,
  getWhatsAppStatusController,
  disconnectWhatsAppController,
} from './whatsappController.js';

const router = Router();

router.get('/status', optionalAuth, getWhatsAppStatusController);
router.post('/disconnect', optionalAuth, disconnectWhatsAppController);
router.get('/threads', authenticate, getThreads);
router.post('/action', authenticate, handleAction);
router.get('/webhook', verifyWebhook);
router.post('/webhook', handleWebhook);
router.post('/send', authenticate, sendTestMessage);
router.post('/embedded-signup', authenticate, handleEmbeddedSignupExchange);
router.post('/connect-manual', optionalAuth, handleManualConnect);
router.get('/oauth/callback', handleOAuthCallback);

export default router;


