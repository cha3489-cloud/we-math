import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://tcpitbsrfouwmfkkdqhg.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_-i657_vcEQefJ-SO6eIVPQ_fZLXYwdb';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const phoneToEmail = (phone) => phone.replace(/[^0-9]/g, '') + '@wemath.kr';
export const padPin = (pin) => 'wm' + pin + 'sq';
