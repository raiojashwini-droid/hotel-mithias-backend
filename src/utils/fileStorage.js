import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Ensure directory exists safely
 */
export function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get sanitized knowledge storage directory for a specific hotel tenant
 */
export function getKnowledgeDir(hotelId) {
  // Prevent path traversal by sanitizing hotelId
  const sanitizedHotelId = String(hotelId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseStorageDir = path.resolve(process.cwd(), 'storage', 'knowledge');
  const hotelDir = path.join(baseStorageDir, sanitizedHotelId);
  ensureDir(hotelDir);
  return hotelDir;
}

/**
 * Save uploaded knowledge file buffer with UUID filename
 */
export async function saveKnowledgeFile(hotelId, file) {
  const hotelDir = getKnowledgeDir(hotelId);
  const ext = path.extname(file.originalname).toLowerCase();
  const uuid = crypto.randomUUID();
  const filename = `${uuid}${ext}`;
  const absolutePath = path.join(hotelDir, filename);

  fs.writeFileSync(absolutePath, file.buffer);

  // Return relative path from storage directory for clean portability
  const baseStorage = path.resolve(process.cwd(), 'storage');
  const relativePath = path.relative(baseStorage, absolutePath).replace(/\\/g, '/');

  return {
    uuid,
    filename,
    absolutePath,
    relativePath,
    size: file.size,
    mimeType: file.mimetype,
    originalName: file.originalname,
  };
}

/**
 * Delete a knowledge file physically from storage
 */
export async function deleteKnowledgeFile(relativePathOrAbsolute) {
  if (!relativePathOrAbsolute) return false;
  try {
    let absolutePath = relativePathOrAbsolute;
    if (!path.isAbsolute(absolutePath)) {
      absolutePath = path.resolve(process.cwd(), 'storage', relativePathOrAbsolute);
    }
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
      return true;
    }
  } catch (err) {
    console.warn(`[fileStorage] Failed to delete file: ${relativePathOrAbsolute}`, err.message);
  }
  return false;
}
