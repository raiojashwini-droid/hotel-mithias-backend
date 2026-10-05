import { Router } from 'express';
import { authenticate, optionalAuth } from '../../middlewares/auth.js';
import { listKnowledge, uploadKnowledge, deleteKnowledge } from './knowledgeController.js';
import path from 'path';

const router = Router();

let multerInstance = null;
try {
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const multerModule = req('multer');
  const multer = multerModule?.default || multerModule;
  if (typeof multer === 'function') {
    multerInstance = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    });
  }
} catch {
  multerInstance = null;
}

const uploadMiddleware = (req, res, next) => {
  if (multerInstance) {
    return multerInstance.single('file')(req, res, () => next());
  }

  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    const boundaryMatch = contentType.match(/boundary=(?:["']?)([^"';]+)(?:["']?)/i);
    const boundary = boundaryMatch ? boundaryMatch[1] : null;

    if (boundary) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          const boundaryDelim = `--${boundary}`;
          const parts = buffer.toString('binary').split(boundaryDelim);

          req.body = req.body || {};
          for (const part of parts) {
            if (!part || part.trim() === '--' || part.trim() === '') continue;
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd === -1) continue;

            const headerText = part.slice(0, headerEnd);
            const content = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));

            const nameMatch = headerText.match(/name="([^"]+)"/i);
            const filenameMatch = headerText.match(/filename="([^"]+)"/i);
            const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);

            if (filenameMatch) {
              const fileBuf = Buffer.from(content, 'binary');
              req.file = {
                originalname: filenameMatch[1],
                mimetype: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
                buffer: fileBuf,
                size: fileBuf.length,
              };
            } else if (nameMatch) {
              req.body[nameMatch[1]] = content;
            }
          }
        } catch (_) {}
        next();
      });
      return;
    }
  }

  next();
};

router.get('/', authenticate, listKnowledge);
router.post('/', authenticate, uploadMiddleware, uploadKnowledge);
router.delete('/:id', authenticate, deleteKnowledge);

export default router;

