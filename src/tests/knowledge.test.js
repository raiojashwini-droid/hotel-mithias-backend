import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { signToken } from '../utils/jwt.js';

describe('Phase 6 Knowledge Base Automated E2E Test Suite', () => {
  let server;
  let baseUrl;
  let tokenA;
  let tokenB;
  let tokenNoHotel;
  const hotelA = 'test-hotel-alpha';
  const hotelB = 'test-hotel-beta';

  // Minimal valid PDF with real extractable text for pdf-parse
  const samplePdfBuffer = Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n' +
    '4 0 obj << /Length 44 >> stream\n' +
    'BT /F1 12 Tf 100 700 Td (Hotel Check-in is at 15:00 and Check-out is at 11:00.) Tj ET\n' +
    'endstream\n' +
    'endobj\n' +
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n' +
    'xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000244 00000 n \n0000000336 00000 n \n' +
    'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n412\n%%EOF'
  );

  const sampleDocxBuffer = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hotel Wi-Fi is complimentary throughout all guest rooms and public areas.</w:t></w:r></w:p></w:body></w:document>'
  );

  const sampleTxtBuffer = Buffer.from(
    'Breakfast is served in the courtyard lounge daily from 07:00 to 10:30. Spa access is available by reservation.'
  );

  const sampleCsvBuffer = Buffer.from(
    'Item,Price,Category\nAirport Shuttle,45,Transport\nLate Check-out,35,Room\nContinental Breakfast,20,Dining\n'
  );

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    tokenA = signToken({ id: 'u-jonas', role: 'manager', email: 'jonas@hotelmercier.be', hotelId: hotelA });
    tokenB = signToken({ id: 'u-amelie', role: 'manager', email: 'amelie@hotelmercier.be', hotelId: hotelB });
    tokenNoHotel = signToken({ id: 'u-jonas', role: 'manager', email: 'jonas@hotelmercier.be' });

    await prisma.knowledgeChunk.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.knowledgeDoc.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
  });

  after(async () => {
    await prisma.knowledgeChunk.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.knowledgeDoc.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });

    const storageDirA = path.resolve(process.cwd(), 'storage', 'knowledge', hotelA);
    const storageDirB = path.resolve(process.cwd(), 'storage', 'knowledge', hotelB);
    if (fs.existsSync(storageDirA)) fs.rmSync(storageDirA, { recursive: true, force: true });
    if (fs.existsSync(storageDirB)) fs.rmSync(storageDirB, { recursive: true, force: true });

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function uploadFile(token, filename, mimeType, buffer, category = 'Hotel Policies') {
    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    formData.append('file', blob, filename);
    formData.append('category', category);

    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return fetch(`${baseUrl}/knowledge`, {
      method: 'POST',
      headers,
      body: formData,
    });
  }

  test('1. Reject upload without JWT authentication (401)', async () => {
    const res = await uploadFile(null, 'test.txt', 'text/plain', sampleTxtBuffer);
    assert.equal(res.status, 401);
  });

  test('2. Reject upload with missing hotelId in token context (401)', async () => {
    const res = await uploadFile(tokenNoHotel, 'test.txt', 'text/plain', sampleTxtBuffer);
    assert.equal(res.status, 401);
  });

  test('3. Reject invalid extension (.exe) (400)', async () => {
    const res = await uploadFile(tokenA, 'malicious.exe', 'application/x-msdownload', Buffer.from('MZ'));
    assert.equal(res.status, 400);
  });

  test('4. Reject mismatched MIME type (400)', async () => {
    const res = await uploadFile(tokenA, 'document.pdf', 'image/png', Buffer.from('fake'));
    assert.equal(res.status, 400);
  });

  test('5. Reject file > 10 MB (413 or 400)', async () => {
    const largeBuffer = Buffer.alloc(10.5 * 1024 * 1024, 'a');
    const res = await uploadFile(tokenA, 'large.txt', 'text/plain', largeBuffer);
    assert.ok(res.status === 413 || res.status === 400);
  });

  let pdfDocId;
  test('6. Upload and index valid PDF document', async () => {
    const res = await uploadFile(tokenA, 'Hotel_Policies.pdf', 'application/pdf', samplePdfBuffer, 'Hotel Policies');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.id);
    assert.equal(json.data.name, 'Hotel_Policies.pdf');
    assert.equal(json.data.status, 'indexed');
    assert.equal(json.data.hotelId, hotelA);
    pdfDocId = json.data.id;

    // Verify DB record
    const doc = await prisma.knowledgeDoc.findUnique({ where: { id: pdfDocId } });
    assert.ok(doc);
    assert.equal(doc.status, 'indexed');
    assert.equal(doc.hotelId, hotelA);

    // Verify physical file exists on disk
    const physicalPath = path.resolve(process.cwd(), 'storage', doc.storagePath);
    assert.ok(fs.existsSync(physicalPath), 'Physical PDF file should exist on disk');

    // Verify chunks
    const chunks = await prisma.knowledgeChunk.findMany({ where: { knowledgeDocId: pdfDocId } });
    assert.ok(chunks.length > 0);
    assert.equal(chunks[0].chunkIndex, 0);
    assert.ok(chunks[0].content.length <= 1000);
  });

  let docxDocId;
  test('7. Upload and index valid DOCX document', async () => {
    const res = await uploadFile(
      tokenA,
      'Facilities.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sampleDocxBuffer,
      'Hotel Information'
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.status, 'indexed');
    docxDocId = json.data.id;

    const chunks = await prisma.knowledgeChunk.findMany({ where: { knowledgeDocId: docxDocId } });
    assert.ok(chunks.length > 0);
    assert.ok(chunks[0].content.includes('Wi-Fi'));
  });

  let txtDocId;
  test('8. Upload and index valid TXT document', async () => {
    const res = await uploadFile(tokenA, 'Breakfast.txt', 'text/plain', sampleTxtBuffer, 'Hotel Information');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.status, 'indexed');
    txtDocId = json.data.id;

    const chunks = await prisma.knowledgeChunk.findMany({ where: { knowledgeDocId: txtDocId } });
    assert.ok(chunks.length > 0);
    assert.ok(chunks[0].content.includes('Breakfast'));
  });

  let csvDocId;
  test('9. Upload and index valid CSV document', async () => {
    const res = await uploadFile(tokenA, 'Upsells.csv', 'text/csv', sampleCsvBuffer, 'Upsells');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.status, 'indexed');
    csvDocId = json.data.id;

    const chunks = await prisma.knowledgeChunk.findMany({ where: { knowledgeDocId: csvDocId } });
    assert.ok(chunks.length > 0);
    assert.ok(chunks[0].content.includes('Airport Shuttle'));
  });

  test('10. Parser failure sets status to error without exposing stack traces', async () => {
    // Malformed/corrupted PDF stream
    const corruptedPdf = Buffer.from('%PDF-1.4 Corrupted content without EOF');
    const res = await uploadFile(tokenA, 'Corrupted.pdf', 'application/pdf', corruptedPdf);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.message, 'File parsing failed');
    assert.equal(json.stack, undefined, 'Stack trace must not be leaked to client');
  });

  test('11. GET /api/knowledge returns only Tenant A documents', async () => {
    const res = await fetch(`${baseUrl}/knowledge`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.length >= 4);
    assert.ok(json.data.every((d) => d.hotelId === hotelA));
  });

  test('12. Tenant B cannot see Tenant A documents (Tenant Isolation)', async () => {
    const res = await fetch(`${baseUrl}/knowledge`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.length, 0, 'Tenant B should see 0 documents');
  });

  test('13. Tenant B cannot delete Tenant A document (404)', async () => {
    const res = await fetch(`${baseUrl}/knowledge/${pdfDocId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 404);

    const doc = await prisma.knowledgeDoc.findUnique({ where: { id: pdfDocId } });
    assert.ok(doc, 'Tenant A document must not be deleted by Tenant B');
  });

  test('14. Tenant A deletes document: removes doc, chunks, and physical file', async () => {
    const docBefore = await prisma.knowledgeDoc.findUnique({ where: { id: pdfDocId } });
    const physicalPath = path.resolve(process.cwd(), 'storage', docBefore.storagePath);
    assert.ok(fs.existsSync(physicalPath));

    const res = await fetch(`${baseUrl}/knowledge/${pdfDocId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);

    const docAfter = await prisma.knowledgeDoc.findUnique({ where: { id: pdfDocId } });
    assert.equal(docAfter, null);

    const chunksAfter = await prisma.knowledgeChunk.findMany({ where: { knowledgeDocId: pdfDocId } });
    assert.equal(chunksAfter.length, 0);

    assert.equal(fs.existsSync(physicalPath), false, 'Physical file must be deleted on document deletion');
  });

  test('15. GET /api/knowledge after delete no longer returns deleted document', async () => {
    const res = await fetch(`${baseUrl}/knowledge`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(!json.data.some((d) => d.id === pdfDocId));
  });
});
