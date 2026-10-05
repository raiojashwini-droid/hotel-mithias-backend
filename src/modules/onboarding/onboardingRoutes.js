import { Router } from 'express';
import {
  getOnboardingStatus,
  getHotelProfile,
  saveHotelProfile,
  saveTopology,
  saveOnboardingStep,
  completeOnboarding,
  handleEmailDetect,
} from './onboardingController.js';
import { authenticate } from '../../middlewares/auth.js';

const router = Router();

router.get('/status', authenticate, getOnboardingStatus);
router.get('/profile', authenticate, getHotelProfile);
router.get('/email-detect', handleEmailDetect);
router.post('/profile', authenticate, saveHotelProfile);
router.post('/topology', authenticate, saveTopology);
router.post('/step', authenticate, saveOnboardingStep);
router.post('/complete', authenticate, completeOnboarding);

export default router;
