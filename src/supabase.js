/**
 * src/supabase.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Supabase integration untuk logging, channel config, dan data persistence
 * 
 * FITUR:
 * - Log bot activity ke Supabase (sebagai backup dari console log)
 * - Simpan channel config (webhook URL, cron schedule)
 * - Query data untuk reporting
 * 
 * USAGE:
 *   import { supabaseLog, getChannelConfig, setChannelConfig } from './supabase.js';
 *   await supabaseLog(env, 'screenshot', { sheetId: 'xxx', status: 'success' });
 *   const config = await getChannelConfig(env, 'group_xxx');
 */

import { createLogger, SERVICES } from './logger.js';

const log = createLogger(SERVICES.SUPABASE);

/**
 * Supabase REST client (lightweight, tanpa library eksternal)
 * Menggunakan service_role key untuk akses penuh
 */
function getSupabaseClient(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!url || !key) {
    log.warn('Supabase not configured: missing URL or service role key');
    return null;
  }
  
  return { url, key };
}

/**
 * Kirim request ke Supabase REST API
 */
async function supabaseRequest(client, method, table, body = null) {
  if (!client) return null;
  
  try {
    const response = await fetch(`${client.url}/rest/v1/${table}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': client.key,
        'Authorization': `Bearer ${client.key}`,
        'Prefer': 'return=minimal'
      },
      body: body ? JSON.stringify(body) : null
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      log.warn(`Supabase ${method} ${table} failed`, { status: response.status, error: errorText.substring(0, 200) });
      return null;
    }
    
    return response;
  } catch (err) {
    log.warn(`Supabase ${method} ${table} error`, err);
    return null;
  }
}

/**
 * Log aktivitas bot ke Supabase
 * 
 * @param {Object} env - Environment variables
 * @param {String} action - Tipe aksi (screenshot, chat, cron, dll)
 * @param {Object} data - Data tambahan (sheetId, status, duration, dll)
 */
export async function supabaseLog(env, action, data = {}) {
  const client = getSupabaseClient(env);
  if (!client) return;
  
  const entry = {
    action,
    data: JSON.stringify(data),
    created_at: new Date().toISOString()
  };
  
  await supabaseRequest(client, 'POST', 'bot_logs', entry);
  log.debug('Logged to Supabase', { action });
}

/**
 * Dapatkan konfigurasi channel dari Supabase
 * 
 * @param {Object} env - Environment variables
 * @param {String} channelId - ID channel/group
 * @returns {Object|null} Channel config atau null
 */
export async function getChannelConfig(env, channelId) {
  const client = getSupabaseClient(env);
  if (!client) return null;
  
  try {
    const response = await fetch(
      `${client.url}/rest/v1/channel_config?channel_id=eq.${encodeURIComponent(channelId)}&limit=1`,
      {
        headers: {
          'apikey': client.key,
          'Authorization': `Bearer ${client.key}`
        }
      }
    );
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    log.warn('Failed to get channel config', err);
    return null;
  }
}

/**
 * Simpan konfigurasi channel ke Supabase
 * 
 * @param {Object} env - Environment variables
 * @param {String} channelId - ID channel/group
 * @param {Object} config - Konfigurasi (webhookUrl, cronMinute, dll)
 */
export async function setChannelConfig(env, channelId, config) {
  const client = getSupabaseClient(env);
  if (!client) return;
  
  const existing = await getChannelConfig(env, channelId);
  
  if (existing) {
    // Update existing
    await supabaseRequest(client, 'PATCH', `channel_config?channel_id=eq.${encodeURIComponent(channelId)}`, {
      ...config,
      updated_at: new Date().toISOString()
    });
  } else {
    // Insert new
    await supabaseRequest(client, 'POST', 'channel_config', {
      channel_id: channelId,
      ...config,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }
  
  log.info('Channel config saved', { channelId, config });
}