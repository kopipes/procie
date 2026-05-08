export function uid(prefix = 'id') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatCurrency(value, currency = 'IDR', locale = 'id-ID') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatDate(dateInput) {
  if (!dateInput) {
    return '-';
  }

  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;

  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatRelativeDate(dateInput) {
  if (!dateInput) {
    return '-';
  }

  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;

  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toPositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function toRate(value, min, max, fallback = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return clamp(parsed, min, max);
}
