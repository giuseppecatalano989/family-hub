import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const digest = token => createHash('sha256').update(token).digest('hex');
export const RECOVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
`;

export function createRecovery({ run, one, atomic, fail, text, passwordHash, mailer, appUrl, scheduleDelivery, clock = Date.now }) {
  const response = { message: 'Se l’indirizzo è registrato, riceverai un link per reimpostare la password. Controlla anche lo spam. Se non arriva, attendi un minuto e riprova.' };
  async function invalidate(userId) { await run('DELETE FROM password_resets WHERE user_id = ?', userId); }
  async function forgot(req, res) {
    const started = performance.now();
    const email = text(req.body.email, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email non valida.');
    if (!mailer) fail('Il recupero via email non è ancora disponibile. Riprova più tardi.', 503);
    let delivery;
    await atomic(async () => {
      await run('DELETE FROM password_resets WHERE expires <= ?', clock());
      const user = await one('SELECT id FROM users WHERE email = ?', email);
      if (!user) return;
      // Limit repeat emails without revealing whether an account exists.
      if (await one('SELECT token_hash FROM password_resets WHERE user_id = ? AND expires > ?', user.id, clock() + 29 * 60000)) return;
      const token = randomBytes(32).toString('hex');
      await invalidate(user.id);
      await run('INSERT INTO password_resets VALUES (?, ?, ?)', digest(token), user.id, clock() + 30 * 60000);
      delivery = { email, token, url: `${appUrl}/#reset=${token}` };
    });
    if (delivery) {
      const sending = (async () => {
        try { await mailer(delivery); }
        catch {
          await run('DELETE FROM password_resets WHERE token_hash = ?', digest(delivery.token));
          // Never expose provider responses, recipients or recovery links in logs.
          console.warn('Invio email di recupero non riuscito.');
        }
      })();
      if (scheduleDelivery) scheduleDelivery(sending);
      else await sending;
    }
    // With background delivery, account lookup and provider latency do not
    // disclose whether an address is registered through the public response.
    await delay(Math.max(0, 200 - (performance.now() - started)));
    res.json(response);
  }
  async function reset(req, res) {
    const token = text(req.body.token, 'Link di recupero', 64);
    if (!/^[a-f0-9]{64}$/.test(token)) fail('Link di recupero non valido o scaduto. Richiedine uno nuovo.');
    const password = text(req.body.newPassword, 'Nuova password', 128);
    if (password.length < 10) fail('Usa una password di almeno 10 caratteri.');
    const encoded = passwordHash(password);
    await atomic(async () => {
      const recovery = await one('SELECT user_id FROM password_resets WHERE token_hash = ? AND expires > ?', digest(token), clock());
      if (!recovery) fail('Link di recupero non valido o scaduto. Richiedine uno nuovo.');
      await run('UPDATE users SET password_hash = ? WHERE id = ?', encoded, recovery.user_id);
      await run('DELETE FROM sessions WHERE user_id = ?', recovery.user_id);
      await invalidate(recovery.user_id);
    });
    res.clearCookie('casa_session', { path: '/' });
    res.json({ ok: true });
  }
  return { forgot, reset, invalidate };
}
