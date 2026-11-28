// The kiosk's only network call: the attendance-code Edge Function over HTTPS.
// The six digits are never sent to PostgREST; the function derives the verifier server-side.
// Authorization is the registered device token, checked by the database through the function.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function createKioskCaller({ fetch, supabaseUrl, publishableKey }) {
  const base = new URL(supabaseUrl);
  if (base.protocol !== 'https:' && !LOCAL_HOSTS.has(base.hostname)) {
    throw new Error('attendance-code function requires HTTPS');
  }
  const endpoint = `${base.origin}/functions/v1/attendance-code`;
  return async function callKiosk(deviceToken, action, code) {
    const response = await fetch(endpoint, {
      method: 'POST',
      cache: 'no-store',
      headers: { apikey: publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'kiosk', device_token: deviceToken, action, code }),
    });
    if (!response.ok) throw new Error(`kiosk request failed (${response.status})`);
    return response.json();
  };
}
