import './kiosk.css';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../portal/client.js';
import { createKioskCaller } from './api.js';
import { mountKiosk } from './app.js';

// Uses only the publishable key. Authorization is the registered device token checked server-side.
const callKiosk = createKioskCaller({
  fetch: (...args) => window.fetch(...args),
  supabaseUrl: SUPABASE_URL,
  publishableKey: SUPABASE_ANON_KEY,
});

mountKiosk(document, { callKiosk, storage: window.localStorage });
