import { createCloudApp } from '../server/cloud.mjs';

let pending;
export default async function handler(request, response) {
  pending ||= createCloudApp().catch(error => { pending = undefined; throw error; });
  try {
    const instance = await pending;
    await new Promise(resolve => {
      response.once('finish', resolve); response.once('close', resolve);
      instance.app(request, response);
    });
  }
  catch {
    // Never fall back to temporary SQLite in a serverless deployment.
    response.statusCode = 503;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'Servizio non disponibile. Verifica la configurazione del database.' }));
  }
}
