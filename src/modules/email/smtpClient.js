import nodemailer from 'nodemailer';
import { prisma } from '../../config/database.js';
import { decryptToken } from '../../utils/tokenCrypto.js';

/**
 * SMTP client utility for Hostinger / Titan and standard credentials mailboxes
 */
export const smtpClient = {
  /**
   * Send outbound email to a guest via authenticated SMTP
   */
  async sendSmtpGuestMail({ hotelId, to, subject, bodyText, threadId }) {
    if (!hotelId || !to || !bodyText) {
      throw new Error('hotelId, to recipient, and bodyText are required for SMTP send');
    }

    const [integration, hotel] = await Promise.all([
      prisma.emailIntegration.findUnique({ where: { hotelId } }),
      prisma.hotel.findUnique({ where: { id: hotelId }, select: { name: true } }),
    ]);

    if (!integration || !integration.accessToken) {
      throw new Error(`No active email integration credentials found for hotel ${hotelId}`);
    }

    const password = decryptToken(integration.accessToken);
    if (!password) {
      throw new Error(`Failed to decrypt SMTP credentials for hotel ${hotelId}`);
    }

    const host = integration.smtpHost || `smtp.${integration.email.split('@')[1]}`;
    const port = integration.smtpPort || 465;
    const isSecure = port === 465;

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: isSecure,
      auth: {
        user: integration.email,
        pass: password,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    const hotelName = hotel?.name || 'Hotel Front Office';
    const info = await transporter.sendMail({
      from: `"${hotelName}" <${integration.email}>`,
      to,
      subject: subject || 'Message from Hotel Reception',
      text: bodyText,
      headers: threadId ? { 'In-Reply-To': threadId, References: threadId } : {},
    });

    return {
      success: true,
      messageId: info.messageId,
      provider: 'credentials',
      to,
      subject,
    };
  },
};
