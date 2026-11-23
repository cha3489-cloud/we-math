import './plan.css';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../portal/client.js';
import { mountPlanDevice } from './app.js';

// Publishable key only, and no auth session: the dedicated device never signs in. Authorization is
// the device token checked by learning_device_today_plan, which is read-only.
const deviceClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sequence.learningPlan.noAuth' },
});

async function readPlan(deviceToken) {
  const { data, error } = await deviceClient.rpc('learning_device_today_plan', { p_device_token: deviceToken });
  if (error) throw error;
  return data;
}

mountPlanDevice(document, { readPlan, storage: window.localStorage });
