/**
 * Brevo (Sendinblue) Transactional Email Dispatcher for Hotelogx Connect
 */

/**
 * Send an invitation email to a newly added hotel staff member via Brevo API
 */
export async function sendBrevoInvitationEmail({
  toEmail,
  toName,
  role = 'front-office',
  title = 'Front Desk Agent',
  hotelName = 'Hotel Mercier',
  loginUrl = 'http://localhost:5173/login',
  temporaryPassword = 'demo-access',
}) {
  if (!toEmail) {
    console.warn('[Brevo Mailer] No recipient email provided');
    return { success: false, reason: 'Recipient email required' };
  }

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'reception@hotelmercier.be';
  const senderName = process.env.BREVO_SENDER_NAME || 'Hotel Mercier Operations';

  // Branded HTML Invitation Template
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #faf8f5; color: #1c1917; margin: 0; padding: 24px; }
          .card { max-width: 540px; margin: 0 auto; background: #ffffff; border: 1px solid #e7e5e4; border-radius: 14px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); }
          .header { display: flex; align-items: center; margin-bottom: 24px; border-bottom: 1px solid #f5f5f4; padding-bottom: 16px; }
          .badge { display: inline-block; background-color: #ecfdf5; color: #047857; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.05em; }
          h1 { font-size: 22px; font-weight: 600; color: #1c1917; margin: 12px 0 8px 0; }
          p { font-size: 14px; line-height: 1.6; color: #44403c; margin: 8px 0; }
          .credentials { background-color: #faf8f5; border: 1px solid #e7e5e4; border-radius: 8px; padding: 16px; margin: 20px 0; }
          .credential-row { font-size: 13px; margin: 4px 0; font-family: monospace; }
          .btn { display: inline-block; background-color: #1e3a34; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 13.5px; font-weight: 500; margin-top: 16px; }
          .footer { margin-top: 24px; font-size: 12px; color: #78716c; text-align: center; border-top: 1px solid #f5f5f4; padding-top: 16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <span class="badge">Staff Invitation</span>
          </div>
          <h1>Welcome to ${hotelName}</h1>
          <p>Hi <strong>${toName || toEmail}</strong>,</p>
          <p>You have been invited to join the <strong>${hotelName}</strong> team on <strong>Hotelogx Connect</strong> as <strong>${title}</strong>.</p>
          
          <div class="credentials">
            <div class="credential-row"><strong>Your Role:</strong> ${title} (${role})</div>
            <div class="credential-row"><strong>Work Email:</strong> ${toEmail}</div>
            <div class="credential-row"><strong>Default Password:</strong> ${temporaryPassword}</div>
          </div>

          <p>Click the button below to access your department workspace:</p>
          <a href="${loginUrl}" class="btn">Sign In to Your Workspace &rarr;</a>

          <div class="footer">
            Hotelogx Connect &bull; AI Front Office & Hotel Operations Assistant
          </div>
        </div>
      </body>
    </html>
  `;

  // Graceful Fallback if Brevo API key is not configured in .env
  if (!apiKey) {
    console.log(`[Brevo Mailer Simulation] Invitation sent to ${toEmail} (${title})`);
    return { success: true, simulated: true };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: toEmail, name: toName || toEmail }],
        subject: `You've been invited to ${hotelName} — Hotelogx Connect`,
        htmlContent,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.warn('[Brevo API Warning]', result?.message || response.statusText);
      return { success: false, error: result };
    }

    console.log(`[Brevo API Success] Email delivered to ${toEmail}, Message ID: ${result?.messageId}`);
    return { success: true, messageId: result?.messageId };
  } catch (err) {
    console.error('[Brevo Network Error]', err.message);
    return { success: false, error: err.message };
  }
}
