// Local Enable Banking double for browser tests: verifies RS256 tokens and
// returns fixed read-only data. Never used outside the e2e suite.
import http from 'node:http';
import { verify } from 'node:crypto';

const publicKey = process.env.MOCK_BANK_PUBLIC_KEY.replaceAll('\\n', '\n');
const port = Number(process.env.MOCK_BANK_PORT || 3101);
const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date()).slice(0, 7);
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
function authorized(req) {
  const [header, payload, signature] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  if (!signature) return false;
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  return claims.aud === 'api.enablebanking.com' && JSON.parse(Buffer.from(header, 'base64url')).kid === 'e2e-app'
    && verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
}
http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') return json(res, 200, { ok: true });
  if (url.pathname === '/authorize') {
    res.writeHead(302, { location: `${url.searchParams.get('redirect')}?code=e2e-code&state=${url.searchParams.get('state')}` });
    return res.end();
  }
  if (url.pathname === '/v1/messages') return advisor(req, res);
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (url.pathname === '/aspsps') return json(res, 200, { aspsps: [{ name: 'Intesa Sanpaolo', country: 'IT', psu_types: ['personal'], maximum_consent_validity: 15552000 }, { name: 'Banca di Prova', country: 'IT', psu_types: ['personal'] }] });
    if (url.pathname === '/auth' && req.method === 'POST') {
      const request = JSON.parse(body);
      return json(res, 200, { url: `http://127.0.0.1:${port}/authorize?state=${request.state}&redirect=${encodeURIComponent(request.redirect_url)}` });
    }
    if (url.pathname === '/sessions' && req.method === 'POST') return json(res, 200, { session_id: 'e2e-session', access: { valid_until: new Date(Date.now() + 150 * 86400000).toISOString() }, accounts: [{ uid: 'e2e-account', account_id: { iban: 'IT60X0542811101000000123456' }, name: 'Conto Famiglia', currency: 'EUR' }, { uid: 'e2e-card', account_id: { iban: 'IT77C0306909606100000000123' }, name: 'Conto secondario', currency: 'EUR', cash_account_type: 'CACC' }, { uid: 'e2e-credit', name: 'Carta di credito', currency: 'EUR', cash_account_type: 'CARD' }] });
    if (url.pathname.endsWith('/balances')) return json(res, 200, { balances: [{ balance_type: 'ITAV', balance_amount: { amount: url.pathname.includes('e2e-card') ? '50.00' : '2345.67', currency: 'EUR' } }] });
    if (url.pathname.includes('e2e-card')) return json(res, 200, { transactions: [] });
    if (url.pathname.endsWith('/transactions')) return json(res, 200, { transactions: [
      { entry_reference: 'e2e-1', transaction_amount: { amount: '54.20', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: `${month}-01`, creditor: { name: 'Esselunga' } },
      { entry_reference: 'e2e-3', transaction_amount: { amount: '150.00', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: `${month}-01`, creditor: { name: 'Trade Republic Bank GmbH' }, creditor_account: { iban: 'IT55T0300203280000000000777' }, remittance_information: ['PAC mensile'] },
      { entry_reference: 'e2e-4', transaction_amount: { amount: '23.00', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: `${month}-01`, creditor: { name: 'Negozio Vario' } },
      { entry_reference: 'e2e-2', transaction_amount: { amount: '1800.00', currency: 'EUR' }, credit_debit_indicator: 'CRDT', status: 'BOOK', booking_date: `${month}-01`, debtor: { name: 'Stipendio Rossi' } },
    ] });
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    json(res, 404, { error: 'not found' });
  });
}).listen(port, '127.0.0.1');

// Anthropic Messages API double for the budget reports: a fixed answer built
// from the figures the server sends, so no data leaves the test.
function advisor(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.headers['x-api-key'] !== 'e2e-anthropic-key') return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid key' } });
    const content = JSON.parse(body).messages[0].content;
    // Pantry analysis: photos arrive as image blocks before the request text.
    if (Array.isArray(content)) {
      if (!content.some(block => block.type === 'image' && block.source?.media_type === 'image/jpeg')) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'no image' } });
      const pantry = { notice: '', found: [{ name: 'Uova', amount: '6' }, { name: 'Zucchine', amount: '2' }, { name: 'Pasta', amount: '1 confezione' }],
        shopping: [{ name: 'Parmigiano', quantity: '200 g', section: 'Frigo e freschi', reason: 'Per completare le ricette' }, { name: 'Latte', quantity: '1 l', section: 'Frigo e freschi', reason: 'Quasi finito' }],
        recipes: [
          { title: 'Pasta e zucchine', servings: 2, minutes: 20, summary: 'Tutto già in casa.', steps: ['Cuoci la pasta con le zucchine'], ingredients: [{ name: 'Pasta', quantity: '200 g', section: 'Dispensa', available: true }, { name: 'Zucchine', quantity: '2', section: 'Frutta e verdura', available: true }] },
          { title: 'Frittata di zucchine', servings: 2, minutes: 25, summary: 'Soffice e veloce.', steps: ['Affetta le zucchine', 'Cuoci con le uova sbattute'], ingredients: [{ name: 'Uova', quantity: '4', section: 'Frigo e freschi', available: true }, { name: 'Zucchine', quantity: '2', section: 'Frutta e verdura', available: true }, { name: 'Parmigiano', quantity: '50 g', section: 'Frigo e freschi', available: false }] },
          { title: 'Pasta al pomodoro', servings: 2, minutes: 20, summary: 'Un classico.', steps: ['Cuoci la pasta'], ingredients: [{ name: 'Pasta', quantity: '200 g', section: 'Dispensa', available: true }, { name: 'Passata di pomodoro', quantity: '1 bottiglia', section: 'Dispensa', available: false }] },
        ] };
      return json(res, 200, { id: 'msg_e2e', type: 'message', role: 'assistant', model: JSON.parse(body).model, content: [{ type: 'text', text: JSON.stringify(pantry) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    const facts = JSON.parse(content);
    const ids = facts.categorie.map(c => c.id);
    const answer = { headline: 'Svago corre più veloce del previsto', summary: 'A metà mese avete già usato buona parte del tempo libero. Rallentate le uscite serali per chiudere nel budget.',
      tips: [{ kind: 'avoid', title: 'Rivedete le cene fuori', detail: 'Due cene a settimana in meno vi riportano nel massimale.' }, { kind: 'adjust', title: 'Ripartizione per questo mese', detail: 'Spostate il 5% da Tempo libero a Risparmio solo per questo mese.' }],
      adjustment: { propose: true, month: facts.mese_corrente, reason: 'Per rientrare dopo le spese di inizio mese.', percentages: [35, 15, 10, 5, 5, 30].map((percent, i) => ({ category_id: ids[i], percent })) },
      categories: facts.uscite_da_classificare.map(u => ({ transaction_id: u.id, category_id: ids[1] })) };
    json(res, 200, { id: 'msg_e2e', type: 'message', role: 'assistant', model: JSON.parse(body).model, content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  });
}
