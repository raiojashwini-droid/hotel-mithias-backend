import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { getTasks, getTaskById, createTask, updateTaskStatus } from './tasksController.js';

const router = Router();

// All Housekeeping task endpoints require a valid JWT
router.get('/', authenticate, getTasks);
router.post('/', authenticate, createTask);
router.get('/:id', authenticate, getTaskById);
router.patch('/:id/status', authenticate, updateTaskStatus);

export default router;
