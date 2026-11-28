import './makeup.css';
import { supabase } from '../portal/client.js';
import { mountMakeupSelection } from './app.js';

const api = {
  async view(token) {
    const { data, error } = await supabase.rpc('makeup_offer_view', { p_token: token });
    if (error) throw error;
    return data;
  },
  async select(token, optionId) {
    const { data, error } = await supabase.rpc('makeup_offer_select', { p_token: token, p_option_id: optionId });
    if (error) throw error;
    return data;
  },
};

mountMakeupSelection(document, {
  hash: window.location.hash,
  replaceState: () => window.history.replaceState(null, '', window.location.pathname),
  api,
});
