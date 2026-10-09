import { Router } from 'express';
import { realtimeService } from '../../services/realtimeService.js';
import { authenticate } from '../../middlewares/auth.js';

const router = Router();

/**
 * SSE Endpoint: GET /api/realtime/events
 * Connects authenticated browser clients to live event stream isolated by tenant hotelId.
 */
router.get('/events', authenticate, (req, res) => {
  const hotelId = req.user?.hotelId;
  if (!hotelId) return res.status(401).json({ success: false, message: 'Authentication required' });
  realtimeService.subscribe(hotelId, req, res);
});

/**
 * Diagnostic Endpoint: GET /api/realtime/stats
 */
router.get('/stats', authenticate, (req, res) => {
  res.json({ success: true, stats: realtimeService.getStats() });
});

export default router;
