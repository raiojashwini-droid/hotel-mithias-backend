/** Parse a multer file buffer and return plain text */
export async function parseFile(file) {
  if (!file || !file.buffer) {
    throw new Error('No file buffer provided for parsing');
  }

  const ext = (file.originalname || '').split('.').pop().toLowerCase();
  const mime = file.mimetype || '';
  const buffer = file.buffer;

  if (mime === 'application/pdf' || ext === 'pdf') {
    if (buffer.includes(Buffer.from('%%EOF'))) {
      try {
        const { createRequire } = await import('module');
        const req = createRequire(import.meta.url);
        const pdfParseModule = req('pdf-parse');
        const parseFn = typeof pdfParseModule === 'function' ? pdfParseModule : pdfParseModule?.default;
        if (typeof parseFn === 'function') {
          const data = await parseFn(buffer);
          if (data && data.text && data.text.trim()) {
            return data.text;
          }
        }
      } catch {
        // fallback to stream extraction below
      }
    }
    const raw = buffer.toString('utf8');
    const matches = raw.match(/\(([^)]+)\)\s*Tj/g);
    if (matches && matches.length > 0) {
      return matches.map(m => m.replace(/[()]/g, '').replace(/\s*Tj/, '')).join(' ');
    }
    return raw;
  }

  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
    const raw = buffer.toString('utf8');
    const xmlMatches = raw.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
    if (xmlMatches && xmlMatches.length > 0) {
      return xmlMatches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
    }
    const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ').trim();
    return cleaned || raw;
  }

  if (mime === 'text/plain' || ext === 'txt' || mime === 'text/csv' || ext === 'csv') {
    return buffer.toString('utf8');
  }

  return buffer.toString('utf8');
}

