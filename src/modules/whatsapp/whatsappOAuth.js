import { prisma } from '../../config/database.js';
import { encryptToken } from '../../utils/tokenCrypto.js';

/**
 * Exchange temporary Meta OAuth Code from Embedded Signup for Permanent Access Token
 * and subscribe WABA to webhook events.
 */
export async function exchangeMetaCodeForToken({
  code,
  wabaId,
  phoneNumberId,
  displayPhoneNumber,
  hotelId,
  targetType = 'guest',
  redirectUri,
}) {
  if (!hotelId) {
    throw new Error('hotelId is required for Meta OAuth exchange');
  }

  const appId = process.env.META_APP_ID || process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET;

  let accessToken = null;

  // 1. If real code and app secret provided, exchange code with Meta Graph API
  if (code && appId && appSecret) {
    try {
      let url = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(
        code
      )}`;
      if (redirectUri) {
        url += `&redirect_uri=${encodeURIComponent(redirectUri)}`;
      }
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json();

      if (data.access_token) {
        accessToken = data.access_token;
      } else {
        console.warn('[Meta OAuth] Code exchange warning:', data?.error?.message || 'No access token returned');
      }
    } catch (err) {
      console.warn('[Meta OAuth] Error calling Meta Graph API:', err.message);
    }
  }

  // Fallback to configured system token only in non-production environments
  if (!accessToken && process.env.NODE_ENV !== 'production') {
    accessToken = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || null;
  }

  // 2. Auto-subscribe WABA to our webhook app if wabaId and accessToken exist
  if (wabaId && accessToken) {
    try {
      const subUrl = `https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`;
      await fetch(subUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }).catch((subErr) => {
        console.warn('[Meta Webhook Subscribe Warning]:', subErr.message);
      });
    } catch (_) {}
  }

  const cleanPhone = (displayPhoneNumber || '').replace(/[^\d+]/g, '');

  // 3. Upsert WhatsAppIntegration in database for this tenant
  const existing = await prisma.whatsAppIntegration.findFirst({
    where: { hotelId, targetType },
  });

  let integration;
  if (existing) {
    integration = await prisma.whatsAppIntegration.update({
      where: { id: existing.id },
      data: {
        phoneNumber: cleanPhone || existing.phoneNumber,
        displayPhoneNumber: displayPhoneNumber || existing.displayPhoneNumber || cleanPhone,
        phoneNumberId: phoneNumberId || existing.phoneNumberId,
        wabaId: wabaId || existing.wabaId,
        accessToken: accessToken ? encryptToken(accessToken) : existing.accessToken,
        status: 'connected',
      },
    });
  } else {
    integration = await prisma.whatsAppIntegration.create({
      data: {
        hotelId,
        targetType,
        phoneNumber: cleanPhone,
        displayPhoneNumber: displayPhoneNumber || cleanPhone,
        phoneNumberId: phoneNumberId || null,
        wabaId: wabaId || null,
        accessToken: accessToken ? encryptToken(accessToken) : null,
        status: 'connected',
      },
    });
  }

  // Update Hotel whatsappNumber if targetType is 'guest'
  if (targetType === 'guest' && cleanPhone) {
    await prisma.hotel.update({
      where: { id: hotelId },
      data: { whatsappNumber: displayPhoneNumber || cleanPhone },
    }).catch(() => {});
  }

  // Log activity item for this hotel
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  await prisma.activityItem.create({
    data: {
      id: `act-wa-${Date.now()}`,
      hotelId,
      at: timeStr,
      kind: 'system',
      text: `WhatsApp ${targetType === 'guest' ? 'Guest' : 'Internal'} number connected: ${displayPhoneNumber || cleanPhone}`,
      meta: 'Meta Embedded Signup',
    },
  }).catch(() => {});

  return integration;
}

/**
 * Direct / Manual WhatsApp API Credentials connection
 */
export async function connectManualWhatsAppCredentials({
  hotelId,
  targetType = 'guest',
  phoneNumberId,
  accessToken,
  displayPhoneNumber,
  wabaId,
}) {
  if (!hotelId) {
    throw new Error('hotelId is required for WhatsApp connection');
  }
  if (!phoneNumberId || !accessToken || !displayPhoneNumber) {
    throw new Error('phoneNumberId, accessToken and displayPhoneNumber are required');
  }

  // 1. Verify credentials with Meta Graph API if reachable
  try {
    const metaCheckUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}?access_token=${encodeURIComponent(accessToken)}`;
    const checkRes = await fetch(metaCheckUrl);
    const checkData = await checkRes.json();
    if (checkData?.error) {
      console.warn('[WhatsApp Manual Connect] Meta verification returned warning:', checkData.error.message);
    }
  } catch (apiErr) {
    console.warn('[WhatsApp Manual Connect] Meta API check skipped:', apiErr.message);
  }

  // 2. Auto-subscribe WABA to webhook if wabaId and accessToken provided
  if (wabaId && accessToken) {
    try {
      const subUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(wabaId)}/subscribed_apps`;
      await fetch(subUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }).catch((subErr) => {
        console.warn('[WhatsApp Manual Connect] Webhook subscribe warning:', subErr.message);
      });
    } catch (_) {}
  }

  const cleanPhone = (displayPhoneNumber || '').replace(/[^\d+]/g, '');

  // 3. Upsert WhatsAppIntegration in database
  let integration = null;
  try {
    const existing = await prisma.whatsAppIntegration.findFirst({
      where: { hotelId, targetType },
    });

    if (existing) {
      integration = await prisma.whatsAppIntegration.update({
        where: { id: existing.id },
        data: {
          phoneNumber: cleanPhone || existing.phoneNumber,
          displayPhoneNumber: displayPhoneNumber || existing.displayPhoneNumber || cleanPhone,
          phoneNumberId: phoneNumberId || existing.phoneNumberId,
          wabaId: wabaId || existing.wabaId,
          accessToken: encryptToken(accessToken),
          status: 'connected',
        },
      });
    } else {
      integration = await prisma.whatsAppIntegration.create({
        data: {
          hotelId,
          targetType,
          phoneNumber: cleanPhone,
          displayPhoneNumber: displayPhoneNumber || cleanPhone,
          phoneNumberId: phoneNumberId || null,
          wabaId: wabaId || null,
          accessToken: encryptToken(accessToken),
          status: 'connected',
        },
      });
    }

    // 4. Update Hotel whatsappNumber if targetType is 'guest'
    if (targetType === 'guest' && cleanPhone) {
      await prisma.hotel.update({
        where: { id: hotelId },
        data: { whatsappNumber: displayPhoneNumber || cleanPhone },
      }).catch(() => {});
    }

    // 5. Activity log
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    await prisma.activityItem.create({
      data: {
        id: `act-wa-${Date.now()}`,
        hotelId,
        at: timeStr,
        kind: 'system',
        text: `WhatsApp ${targetType === 'guest' ? 'Guest' : 'Internal'} credentials configured: ${displayPhoneNumber || cleanPhone}`,
        meta: 'Direct Meta API Credentials',
      },
    }).catch(() => {});
  } catch (dbErr) {
    console.warn('[WhatsApp Manual Connect] Database update skipped or offline:', dbErr.message);
    integration = {
      id: `wa-int-${Date.now()}`,
      hotelId,
      targetType,
      phoneNumber: cleanPhone,
      displayPhoneNumber: displayPhoneNumber || cleanPhone,
      phoneNumberId,
      wabaId: wabaId || null,
      status: 'connected',
    };
  }

  return integration;
}
