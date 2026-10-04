export const DEFAULT_APP_URL = 'https://family-hub-giuseppecatalano.vercel.app';

export function resetEmailSender({ provider = process.env.EMAIL_PROVIDER || (process.env.BREVO_API_KEY ? 'brevo' : 'resend'), apiKey, from = process.env.EMAIL_FROM, fetcher = fetch } = {}) {
  apiKey ??= provider === 'brevo' ? process.env.BREVO_API_KEY : process.env.RESEND_API_KEY;
  if (!apiKey || !from) return null;
  if (!['brevo', 'resend'].includes(provider)) throw new Error('Configura EMAIL_PROVIDER come brevo o resend.');
  const address = from.match(/<([^<>]+)>$/)?.[1] || from;
  if (/[\r\n]/.test(from) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new Error('Configura EMAIL_FROM con un mittente verificato.');
  const name = from.includes('<') ? from.slice(0, from.lastIndexOf('<')).trim() : 'Family Hub';
  return async ({ email, url }) => {
    const subject = 'Reimposta la password di Family Hub';
    const text = `Hai richiesto di reimpostare la password di Family Hub.\n\nApri questo link per scegliere una nuova password:\n${url}\n\nIl link è monouso e scade tra 30 minuti. Se non hai richiesto il cambio, ignora questa email: la tua password rimane invariata.\n\nFamily Hub`;
    const response = await fetcher(provider === 'brevo' ? 'https://api.brevo.com/v3/smtp/email' : 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { ...(provider === 'brevo' ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }), 'Content-Type': 'application/json' },
      body: JSON.stringify(provider === 'brevo' ? { sender: { name, email: address }, to: [{ email }], subject, textContent: text } : { from, to: [email], subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Invio email non riuscito.');
  };
}
