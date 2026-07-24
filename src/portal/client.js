import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
export const phoneToEmail = (phone) => phone.replace(/[^0-9]/g, '') + '@wemath.kr';
export const padPin = (pin) => 'wm' + pin + 'sq';
