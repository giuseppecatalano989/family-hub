// Private, read-only operator checks. Never log credentials, addresses, URLs,
// provider response bodies or reset tokens. This command has no HTTP route.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { openPostgres } from './postgres.mjs';

let db;
try {
  const { values } = parseArgs({ options: { account: { type: 'string' }, 'address-hash': { type: 'string' } } });
  if (!values.account || !/^[a-f0-9]{64}$/.test(values['address-hash'] || '')) throw new Error('Missing diagnostic arguments');
  const provider = process.env.EMAIL_PROVIDER || (process.env.BREVO_API_KEY ? 'brevo' : 'resend');
  if (provider !== 'brevo') throw new Error('Brevo is not selected');
  const key = process.env.BREVO_API_KEY;
  const from = process.env.EMAIL_FROM || '';
  const sender = (from.match(/<([^<>]+)>$/)?.[1] || from).toLowerCase();
  if (!key || !sender) throw new Error('Missing mail configuration');
  db = await openPostgres(process.env.DATABASE_URL);
  const accounts = await db.prepare("SELECT email FROM users WHERE lower(trim(name)) = lower(trim(?)) AND role = 'admin'").all(values.account);
  await db.close(); db = undefined;
  const result = { accountMatches: accounts.length, requestedAddressMatchesAccount: accounts.length === 1 && createHash('sha256').update(accounts[0].email.toLowerCase()).digest('hex') === values['address-hash'], keyFormat: { apiPrefix: key.startsWith('xkeysib-'), smtpPrefix: key.startsWith('xsmtpsib-'), surroundingWhitespace: key !== key.trim(), wrappedInQuotes: /^['"]|['"]$/.test(key) } };
  async function check(path) {
    try {
      const response = await fetch('https://api.brevo.com/v3/' + path, { headers: { 'api-key': key }, signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      const knownCodes = ['unauthorized', 'permission_denied', 'invalid_parameter', 'missing_parameter', 'not_enough_credits', 'account_under_validation'];
      return { data, safe: { status: response.status, code: knownCodes.includes(data.code) ? data.code : undefined, keyNotFound: /key not found/i.test(data.message || ''), ipAuthorizationRequired: /unrecognised IP|unrecognized IP|IP address.*(?:authoriz|allow)/i.test(data.message || '') } };
    } catch { return { data: {}, safe: { failed: true } }; }
  }
  const account = await check('account');
  result.brevoAccount = { ...account.safe, smtpEnabled: account.data.smtp?.relay?.enabled };
  const senders = await check('senders');
  const matches = (senders.data.senders || []).filter(item => item.email?.toLowerCase() === sender);
  result.sender = { ...senders.safe, matches: matches.length, active: matches.length === 1 && matches[0].active === true };
  const events = accounts.length === 1 ? await check('smtp/statistics/events?limit=10&email=' + encodeURIComponent(accounts[0].email.toLowerCase())) : { safe: { skipped: true }, data: {} };
  const knownEvents = ['requests', 'request', 'delivered', 'hardBounces', 'softBounces', 'blocked', 'invalid', 'error', 'deferred', 'spam', 'opened', 'clicks', 'proxy_open'];
  result.events = { ...events.safe, entries: (events.data.events || []).map(item => ({ event: knownEvents.includes(item.event) ? item.event : 'other', date: /^\d{4}-\d{2}-\d{2}T/.test(item.date || '') ? item.date : undefined })) };
  console.log('MAIL_DIAGNOSTICS_RESULT ' + JSON.stringify(result));
} catch {
  console.error('MAIL_DIAGNOSTICS_RESULT ' + JSON.stringify({ failed: true }));
  process.exitCode = 1;
} finally { await db?.close(); }
