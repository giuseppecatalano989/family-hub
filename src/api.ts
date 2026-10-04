let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  if (form && method === 'POST' && url.endsWith('/attachments')) {
    const file = body.get('file');
    if (!(file instanceof File)) throw new ApiError('Seleziona un file.', 400);
    const base = url.replace(/attachments$/, 'uploads');
    const upload = await api<{ id: string }>(base, 'POST', { name: file.name, mime: file.type, size: file.size });
    const chunkSize = 2 * 1024 * 1024;
    for (let index = 0; index < Math.max(1, Math.ceil(file.size / chunkSize)); index++) {
      await api(`${base}/${upload.id}/chunks/${index}`, 'PUT', file.slice(index * chunkSize, (index + 1) * chunkSize));
    }
    return api<T>(`${base}/${upload.id}/complete`, 'POST');
  }
  const binary = body instanceof Blob;
  const response = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body && !form ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Requested-With': 'Casa', 'X-CSRF-Token': csrf } : {}) },
    body: body ? (form || binary ? body : JSON.stringify(body)) as BodyInit : undefined,
  });
  const data = await response.json().catch(() => ({ error: 'Risposta del server non valida.' }));
  if (!response.ok) throw new ApiError(data.error || 'Impossibile completare la richiesta.', response.status);
  return data as T;
}
