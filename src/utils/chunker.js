export function chunkText(text, size = 1000) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  const cleanText = text.trim();
  if (!cleanText) {
    return [];
  }
  const chunks = [];
  let index = 0;
  for (let i = 0; i < cleanText.length; i += size) {
    const piece = cleanText.slice(i, i + size);
    chunks.push({ index: index++, content: piece });
  }
  return chunks;
}
