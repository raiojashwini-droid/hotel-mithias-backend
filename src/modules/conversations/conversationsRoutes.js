import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import {
  getConversations,
  getConversationById,
  sendReply,
  receiveGuestMessage,
  toggleTakeover,
  escalateConversation,
  resolveConversation,
} from './conversationsController.js';

const router = Router();
router.use(authenticate);

router.get('/', getConversations);
router.get('/:id', getConversationById);
router.post('/:id/reply', sendReply);
router.post('/:id/message', receiveGuestMessage);
router.post('/:id/takeover', toggleTakeover);
router.post('/:id/escalate', escalateConversation);
router.post('/:id/resolve', resolveConversation);

export default router;

