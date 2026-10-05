import crypto from 'node:crypto';

/**
 * Token Encryption & Decryption Utility using AES-256-GCM
 * Securely encrypts access_token and refresh_token at rest in MySQL.
 */

function getEncryptionKey() {
  const rawKey = process.env.DB_ENCRYPTION_KEY || process.env.JWT_SECRET || 'hotelogx-connect-default-secure-encryption-key-32b';
  // Derive 32-byte key using SHA-256
  return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * Encrypt a plaintext token (accessToken / refreshToken)
 * Returns format: "iv_hex:auth_tag_hex:encrypted_data_hex"
 */
export function encryptToken(plainText) {
  if (!plainText || typeof plainText !== 'string') return null;

  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12); // 96-bit IV for AES-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err) {
    console.error('[TokenCrypto] Encryption error:', err.message);
    throw new Error('Failed to encrypt credential token');
  }
}

/**
 * Decrypt an encrypted token
 */
export function decryptToken(encryptedString) {
  if (!encryptedString || typeof encryptedString !== 'string') return null;

  // Support plain format fallback if unencrypted during development
  if (!encryptedString.includes(':')) {
    return encryptedString;
  }

  try {
    const [ivHex, authTagHex, encryptedDataHex] = encryptedString.split(':');
    if (!ivHex || !authTagHex || !encryptedDataHex) {
      return null;
    }

    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedDataHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[TokenCrypto] Decryption error:', err.message);
    return null;
  }
}

/**
 * Generates a signed OAuth state token containing hotelId, timestamp, and HMAC signature
 */
export function generateOAuthState(hotelId, redirectBack = '/onboarding', frontendOrigin = null) {
  if (!hotelId) throw new Error('hotelId is required for OAuth state generation');
  const payload = {
    hotelId,
    redirectBack,
    frontendOrigin,
    ts: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
  };

  const payloadStr = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadStr, 'utf8').toString('base64url');
  const secret = process.env.JWT_SECRET || process.env.DB_ENCRYPTION_KEY || 'oauth-state-secret-key';
  const hmac = crypto.createHmac('sha256', secret).update(payloadBase64).digest('base64url');

  return `${payloadBase64}.${hmac}`;
}

/**
 * Verifies and decodes a signed OAuth state token
 */
export function verifyOAuthState(stateString) {
  if (!stateString || typeof stateString !== 'string' || !stateString.includes('.')) {
    return { valid: false, error: 'Malformed state parameter' };
  }

  try {
    const [payloadBase64, providedHmac] = stateString.split('.');
    const secret = process.env.JWT_SECRET || process.env.DB_ENCRYPTION_KEY || 'oauth-state-secret-key';
    const expectedHmac = crypto.createHmac('sha256', secret).update(payloadBase64).digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(providedHmac), Buffer.from(expectedHmac))) {
      return { valid: false, error: 'OAuth state signature mismatch' };
    }

    const payloadJson = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);

    // Max 15 minutes validity for OAuth state
    if (Date.now() - payload.ts > 15 * 60 * 1000) {
      return { valid: false, error: 'OAuth state has expired' };
    }

    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: `Invalid state: ${err.message}` };
  }
}
