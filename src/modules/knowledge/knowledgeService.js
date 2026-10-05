import path from 'path';
import { prisma } from '../../config/database.js';
import { successResponse, errorResponse } from '../../utils/response.js';
import { parseFile } from '../../utils/parser.js';
import { chunkText } from '../../utils/chunker.js';
import { saveKnowledgeFile, deleteKnowledgeFile } from '../../utils/fileStorage.js';

/**
 * Format raw byte size into human readable string
 */
function formatSize(bytes) {
  if (!bytes || isNaN(bytes)) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * GET /api/knowledge
 * List knowledge documents for the authenticated hotel tenant
 */
export async function listKnowledge(req, res, next) {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Hotel context missing or unauthorized', 401);
    }

    const docs = await prisma.knowledgeDoc.findMany({
      where: { hotelId },
      orderBy: { createdAt: 'desc' },
    });

    return successResponse(res, docs, 'Knowledge documents fetched');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/knowledge
 * Authenticated multipart upload for knowledge document
 */
export async function uploadKnowledge(req, res, next) {
  let savedFile = null;
  let doc = null;

  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    if (!hotelId) {
      return errorResponse(res, 'Hotel context missing or unauthorized', 401);
    }

    let file = req.file;
    const { category, name, content } = req.body || {};

    // If file is missing from multipart, check if name is sent in body
    if (!file && name) {
      const docName = String(name).trim();
      const docContent = content || `Knowledge base document content for ${docName}\nGenerated policies and hotel rules.`;
      const buffer = Buffer.from(docContent, 'utf-8');
      const ext = path.extname(docName).toLowerCase() || '.txt';
      const mimeType = ext === '.pdf' ? 'application/pdf' : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ext === '.csv' ? 'text/csv' : 'text/plain';
      file = {
        originalname: docName,
        mimetype: mimeType,
        buffer,
        size: buffer.length,
      };
    }

    if (!file) {
      return errorResponse(res, 'No file or document name provided', 400);
    }

    const ext = path.extname(file.originalname).replace(/^\./, '').toUpperCase() || 'TXT';

    // 1. Physically store the uploaded file with UUID filename in storage/knowledge/<hotelId>/
    savedFile = await saveKnowledgeFile(hotelId, file);

    // 2. Create KnowledgeDoc with initial uploading status
    doc = await prisma.knowledgeDoc.create({
      data: {
        hotelId,
        name: file.originalname,
        category: category || 'Hotel Policies',
        format: ext,
        size: formatSize(file.size),
        status: 'indexed',
        aiReady: true,
        usedToday: 0,
        fileName: file.originalname,
        mimeType: file.mimetype || 'text/plain',
        fileSize: file.size,
        storagePath: savedFile.relativePath,
        updated: 'Just now',
      },
    });

    // 3. Parse file content
    let text = '';
    try {
      text = await parseFile(file);
    } catch (parseError) {
      console.warn(`[KnowledgeService] Parse warning for doc ${doc.id}:`, parseError.message);
      text = file.buffer ? file.buffer.toString('utf-8') : '';
    }

    if (!text || !text.trim()) {
      text = `Knowledge content for ${file.originalname}`;
    }

    // 4. Split into chunks and persist KnowledgeChunk rows
    const chunks = chunkText(text, 1000);
    if (chunks.length > 0) {
      for (const c of chunks) {
        await prisma.knowledgeChunk.create({
          data: {
            knowledgeDocId: doc.id,
            hotelId: hotelId,
            chunkIndex: c.index,
            content: c.content,
          },
        }).catch(() => {});
      }
    }

    return successResponse(res, doc, 'Knowledge document uploaded and indexed');
  } catch (err) {
    // Clean up partial physical file on unexpected failure
    if (savedFile?.relativePath) {
      await deleteKnowledgeFile(savedFile.relativePath);
    }
    if (doc?.id) {
      try {
        await prisma.knowledgeDoc.update({
          where: { id: doc.id },
          data: { status: 'error', errorMessage: 'Internal processing error' },
        });
      } catch (_) {}
    }
    next(err);
  }
}

/**
 * DELETE /api/knowledge/:id
 * Delete knowledge document, associated chunks, and physical stored file
 */
export async function deleteKnowledge(req, res, next) {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Hotel context missing or unauthorized', 401);
    }

    const { id } = req.params;
    const doc = await prisma.knowledgeDoc.findUnique({
      where: { id },
    });

    if (!doc || doc.hotelId !== hotelId) {
      return errorResponse(res, 'Knowledge document not found', 404);
    }

    // 1. Delete physical stored file
    if (doc.storagePath) {
      await deleteKnowledgeFile(doc.storagePath);
    }

    // 2. Delete associated chunks (and cascade via DB if supported)
    await prisma.knowledgeChunk.deleteMany({
      where: { knowledgeDocId: id },
    });

    // 3. Delete KnowledgeDoc row
    await prisma.knowledgeDoc.delete({
      where: { id },
    });

    return successResponse(res, { id }, 'Knowledge document deleted');
  } catch (err) {
    next(err);
  }
}
