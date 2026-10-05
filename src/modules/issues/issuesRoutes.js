import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { getIssues, createIssue, updateIssueStatus, assignIssue } from './issuesController.js';

const router = Router();

// All Maintenance issue endpoints require a valid JWT
router.get('/', authenticate, getIssues);
router.post('/', authenticate, createIssue);
router.patch('/:id/status', authenticate, updateIssueStatus);
router.patch('/:id/assign', authenticate, assignIssue);

export default router;
