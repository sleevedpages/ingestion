type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: string): void {
  currentLevel = (level in LEVELS ? level : 'info') as LogLevel;
}

function emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (data) Object.assign(entry, data);

  const line = JSON.stringify(entry);
  // Workers and Node both support these console methods;
  // Cloudflare surfaces them in the dashboard's live log viewer.
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, data?: Record<string, unknown>) => emit('debug', message, data),
  info:  (message: string, data?: Record<string, unknown>) => emit('info',  message, data),
  warn:  (message: string, data?: Record<string, unknown>) => emit('warn',  message, data),
  error: (message: string, data?: Record<string, unknown>) => emit('error', message, data),
};
