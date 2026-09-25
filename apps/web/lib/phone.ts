export function normalizePhone(value: string, countryCode = ''): string {
  const raw = value.trim();
  if (/^\+[1-9][0-9]{6,14}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (countryCode && /^\+[1-9][0-9]{0,3}$/.test(countryCode)) {
    const prefix = countryCode.slice(1);
    if (digits.length >= 6 && digits.length <= 14) return `+${prefix}${digits}`;
  }
  if (/^52[0-9]{10}$/.test(digits)) return `+${digits}`;
  if (/^[0-9]{10}$/.test(digits)) return `+52${digits}`;
  return '';
}
