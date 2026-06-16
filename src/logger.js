/**
 * src/logger.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * 
 * Centralized structured logging untuk semua layanan.
 * 
 * FITUR:
 * - Log levels: DEBUG, INFO, WARN, ERROR
 * - Service tags: CORE, SEATALK, GOOGLE, AI, VERCEL, SUPABASE
 * - Structured JSON output untuk machine parsing
 * - Human-readable console output
 * - Local file logging (saat dev / wrangler dev)
 * - Context support: requestId, targetId, dll
 * - Child logger untuk propagasi context
 * 
 * USAGE:
 *   import { createLogger, SERVICES } from './logger.js';
 *   const log = createLogger(SERVICES.SEATALK, { requestId: 'abc123' });
 *   log.info('Token obtained');
 *   log.error('API call failed', error);
 *   const subLog = log.child({ targetId: 'U123' });
 *   subLog.info('Reply sent');
 * 
 * LOG FILE (local dev):
 *   Logs otomatis ditulis ke ./logs/vasa-{date}.log saat environment mendukung filesystem.
 *   Di Cloudflare Workers production, logs hanya ke console (Workers Log Pipeline).
 *   Di Vercel production, logs ke console (Vercel Log Drains).
 */

// Dynamic imports for node:fs and node:path (not available in Cloudflare Workers)
let fs, path;
try {
  fs = await import('node:fs');
  path = await import('node:path');
} catch {
  // Cloudflare Workers - filesystem not available
}

// ============================================================
// CONSTANTS
// ============================================================

export const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export const SERVICES = {
  CORE:       'CORE',       // Entry point, routing, cron
  SEATALK:    'SEATALK',    // SeaTalk API (token, send, upload, webhook)
  GOOGLE:     'GOOGLE',     // Google Sheets, Drive, OAuth
  AI:         'AI',         // Cloudflare Workers AI
  VERCEL:     'VERCEL',     // Vercel PDF-to-PNG endpoint
  SUPABASE:   'SUPABASE',   // Supabase database
};

// Level names untuk output
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

// Minimum log level - set via setLogLevel()
let _minLevel = LOG_LEVELS.DEBUG;

// File logging state
let _fileLoggingEnabled = false;
let _logDir = null;
let _currentLogFile = null;
let _currentLogDate = null;

// ============================================================
// CONFIGURATION
// ============================================================

/**
 * Set minimum log level
 * @param {number} level - LOG_LEVELS value
 */
export function setLogLevel(level) {
  _minLevel = level;
}

/**
 * Attempt to enable file logging ke ./logs/ directory.
 * Akan diam-diam gagal (tanpa throw) jika filesystem tidak tersedia
 * (contoh: Cloudflare Workers production).
 */
function _initFileLogging() {
  try {
    if (!fs?.default?.mkdirSync || !path?.default?.join) return;
    
    // Coba tulis ke working directory
    _logDir = path.default.join(process.cwd(), 'logs');
    
    // Cek apakah kita di environment yang punya filesystem
    if (typeof fs.default.mkdirSync === 'function') {
      fs.default.mkdirSync(_logDir, { recursive: true });
      _fileLoggingEnabled = true;
      _rotateLogFileIfNeeded();
    }
  } catch {
    // Filesystem tidak tersedia (Cloudflare Workers production) - silent fail
    _fileLoggingEnabled = false;
  }
}

/**
 * Rotate log file berdasarkan tanggal.
 * File format: logs/vasa-YYYY-MM-DD.log
 */
function _rotateLogFileIfNeeded() {
  if (!_fileLoggingEnabled || !_logDir) return;
  
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  
  if (_currentLogDate !== today) {
    _currentLogDate = today;
    _currentLogFile = path.default.join(_logDir, `vasa-${today}.log`);
  }
}

/**
 * Append satu baris log ke file
 * @param {string} line - Formatted log line
 */
function _writeToFile(line) {
  if (!_fileLoggingEnabled) return;
  
  try {
    _rotateLogFileIfNeeded();
    if (_currentLogFile) {
      fs.default.appendFileSync(_currentLogFile, line + '\n', { encoding: 'utf-8' });
    }
  } catch {
    // Silent fail - jangan crash hanya karena logging gagal
  }
}

// Inisialisasi file logging saat module dimuat
_initFileLogging();

// ============================================================
// CORE LOG FUNCTION
// ============================================================

/**
 * Format log entry
 * @param {number} level - Log level
 * @param {string} service - Service tag
 * @param {string} msg - Log message
 * @param {Object|Error|string|undefined} data - Additional data
 * @param {Object} context - Context data (requestId, targetId, etc.)
 * @returns {{ line: string, entry: Object }}
 */
function _formatEntry(level, service, msg, data, context) {
  const timestamp = new Date().toISOString();
  const levelName = LEVEL_NAMES[level];
  
  // Structured entry (untuk JSON parsing)
  const entry = {
    ts: timestamp,
    level: levelName,
    svc: service,
    msg,
  };
  
  // Merge context
  if (context && Object.keys(context).length > 0) {
    Object.assign(entry, context);
  }
  
  // Attach data
  if (data !== undefined && data !== null) {
    if (data instanceof Error) {
      entry.err = {
        name: data.name,
        message: data.message,
        stack: data.stack,
      };
    } else if (typeof data === 'object') {
      // Clone untuk avoid circular reference
      try {
        entry.data = JSON.parse(JSON.stringify(data));
      } catch {
        entry.data = String(data);
      }
    } else {
      entry.data = data;
    }
  }
  
  // Human-readable line
  const contextStr = context && Object.keys(context).length > 0
    ? ' ' + JSON.stringify(context)
    : '';
  const dataStr = data !== undefined && data !== null
    ? ' ' + (data instanceof Error ? data.message : (typeof data === 'object' ? JSON.stringify(data) : String(data)))
    : '';
  
  const line = `[${timestamp}] [${levelName.padEnd(5)}] [${service}]${contextStr} ${msg}${dataStr}`;
  
  return { line, entry };
}

/**
 * Core log function
 * @param {number} level - Log level
 * @param {string} service - Service tag
 * @param {string} msg - Message
 * @param {Object|Error|string|undefined} data - Data
 * @param {Object} context - Context
 * @returns {Object} Log entry
 */
function _log(level, service, msg, data, context) {
  if (level < _minLevel) return null;
  
  const { line, entry } = _formatEntry(level, service, msg, data, context);
  
  // Console output (akan ditangkap oleh CF Workers Log / Vercel Logs)
  if (level >= LOG_LEVELS.ERROR) {
    console.error(line);
  } else if (level >= LOG_LEVELS.WARN) {
    console.warn(line);
  } else {
    console.log(line);
  }
  
  // File output (local dev only)
  _writeToFile(line);
  
  return entry;
}

// ============================================================
// LOGGER FACTORY
// ============================================================

/**
 * Buat logger instance untuk service tertentu
 * 
 * @param {string} service - Service tag dari SERVICES
 * @param {Object} defaultContext - Context default (requestId, targetId, dll)
 * @returns {Object} Logger instance
 * 
 * @example
 *   const log = createLogger(SERVICES.SEATALK);
 *   log.info('Token refreshed');
 *   log.error('Send failed', { status: 401, body: '...' });
 * 
 * @example
 *   const log = createLogger(SERVICES.CORE, { requestId: crypto.randomUUID() });
 *   log.info('Request received');
 *   const subLog = log.child({ targetId: 'U123' });
 *   subLog.info('Processing command');
 */
export function createLogger(service, defaultContext = {}) {
  return {
    debug: (msg, data) => _log(LOG_LEVELS.DEBUG, service, msg, data, defaultContext),
    info:  (msg, data) => _log(LOG_LEVELS.INFO,  service, msg, data, defaultContext),
    warn:  (msg, data) => _log(LOG_LEVELS.WARN,  service, msg, data, defaultContext),
    error: (msg, data) => _log(LOG_LEVELS.ERROR, service, msg, data, defaultContext),
    
    /**
     * Buat child logger dengan context tambahan
     * Context parent di-merge dengan context child
     */
    child: (extraContext) => createLogger(service, { ...defaultContext, ...extraContext }),
    
    /**
     * Log request masuk (convenience method)
     */
    requestIn: (method, path, extra) => {
      _log(LOG_LEVELS.INFO, service, `→ ${method} ${path}`, null, { ...defaultContext, ...extra });
    },
    
    /**
     * Log response keluar (convenience method)
     */
    requestOut: (method, url, status, duration) => {
      const extra = { method, status, duration };
      const level = status >= 400 ? LOG_LEVELS.ERROR : LOG_LEVELS.DEBUG;
      _log(level, service, `← ${status} ${url}`, null, { ...defaultContext, ...extra });
    },
    
    /**
     * Log SeaTalk API call
     */
    apiCall: (api, targetId, extra) => {
      _log(LOG_LEVELS.INFO, service, `API Call: ${api}`, null, { ...defaultContext, targetId, ...extra });
    },
    
    /**
     * Log SeaTalk API response
     */
    apiResponse: (api, responseCode, extra) => {
      const level = responseCode === 0 ? LOG_LEVELS.DEBUG : LOG_LEVELS.WARN;
      _log(level, service, `API Response: ${api} (code=${responseCode})`, null, { ...defaultContext, ...extra });
    },
  };
}

// ============================================================
// UTILITY
// ============================================================

/**
 * Get info tentang log file (untuk debugging)
 */
export function getLogFileInfo() {
  _rotateLogFileIfNeeded();
  return {
    fileLoggingEnabled: _fileLoggingEnabled,
    logDir: _logDir,
    currentLogFile: _currentLogFile,
    currentLogDate: _currentLogDate,
    minLevel: LEVEL_NAMES[_minLevel],
  };
}

/**
 * Get recent log entries dari log file (untuk debugging)
 * @param {number} lines - Jumlah baris terakhir
 * @returns {string} Log content
 */
export function getRecentLogs(lines = 50) {
  if (!_fileLoggingEnabled || !_currentLogFile) return '';
  
  try {
    const content = fs.default.readFileSync(_currentLogFile, 'utf-8');
    const allLines = content.split('\n').filter(Boolean);
    return allLines.slice(-lines).join('\n');
  } catch {
    return '';
  }
}