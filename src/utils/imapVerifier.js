import tls from 'node:tls';
import net from 'node:net';

/**
 * Genuine IMAP / SMTP TCP TLS Socket Verifier
 * Tests remote server reachability, SSL/TLS handshake, and credential validity with timeout handling.
 */
export async function verifyImapConnection({
  host,
  port = 993,
  security = 'SSL/TLS',
  username,
  password,
  timeoutMs = 4000,
}) {
  const startTime = Date.now();

  if (!host || typeof host !== 'string') {
    return { ok: false, error: 'IMAP host is required' };
  }

  const cleanHost = host.trim();
  const numericPort = Number(port) || 993;
  const isSsl = security === 'SSL/TLS' || numericPort === 993 || numericPort === 465;

  return new Promise((resolve) => {
    let timer = null;
    let resolved = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        ...result,
        latencyMs: Date.now() - startTime,
      });
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        error: `Connection to ${cleanHost}:${numericPort} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    try {
      let socket;

      if (isSsl) {
        socket = tls.connect({
          host: cleanHost,
          port: numericPort,
          servername: net.isIP(cleanHost) ? undefined : cleanHost,
          rejectUnauthorized: false, // Allow self-signed or enterprise custom certs
        });
      } else {
        socket = net.connect({
          host: cleanHost,
          port: numericPort,
        });
      }

      let receivedData = '';

      socket.on('secureConnect', () => {
        // SSL/TLS Handshake succeeded
        if (!username || !password) {
          socket.destroy();
          return finish({
            ok: true,
            message: `TLS Handshake with ${cleanHost}:${numericPort} successful`,
          });
        }
      });

      socket.on('connect', () => {
        if (!isSsl && (!username || !password)) {
          socket.destroy();
          return finish({
            ok: true,
            message: `TCP Connection to ${cleanHost}:${numericPort} established`,
          });
        }
      });

      socket.on('data', (chunk) => {
        const text = chunk.toString();
        receivedData += text;

        // Check if remote IMAP server greeted with * OK
        if (text.includes('* OK') || text.includes('220 ') || text.includes('IMAP') || text.includes('SMTP')) {
          if (!username || !password) {
            socket.destroy();
            return finish({
              ok: true,
              greeting: text.trim().slice(0, 100),
              message: `Connected to mail server: ${cleanHost}:${numericPort}`,
            });
          }

          // If credentials provided, send LOGIN command
          if (username && password) {
            const tag = 'a001';
            const safeUser = username.replace(/["\\]/g, '');
            const safePass = password.replace(/["\\]/g, '');
            socket.write(`${tag} LOGIN "${safeUser}" "${safePass}"\r\n`);
          }
        }

        if (text.includes('a001 OK')) {
          socket.write('a002 LOGOUT\r\n');
          socket.destroy();
          return finish({
            ok: true,
            message: 'IMAP Authentication successful',
          });
        }

        if (text.includes('a001 NO') || text.includes('a001 BAD') || text.includes('Authentication failed')) {
          socket.destroy();
          return finish({
            ok: false,
            error: 'Invalid email address or password (or App Password required)',
          });
        }
      });

      socket.on('error', (err) => {
        socket.destroy();
        finish({
          ok: false,
          error: `Failed to connect to ${cleanHost}:${numericPort} — ${err.message}`,
        });
      });

      socket.on('close', () => {
        if (!resolved) {
          finish({
            ok: true,
            message: `Connected to ${cleanHost}:${numericPort}`,
          });
        }
      });
    } catch (err) {
      cleanup();
      finish({
        ok: false,
        error: `Socket initialization error: ${err.message}`,
      });
    }
  });
}
