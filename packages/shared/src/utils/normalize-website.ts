/**
 * Normalize website URL to domain-only for matching
 * Examples:
 *   "https://www.tcichemicals.com/US/en/" → "tcichemicals.com"
 *   "http://tcichemicals.com/products/" → "tcichemicals.com"
 *   "tcichemicals.com" → "tcichemicals.com"
 *   "www.tcichemicals.com" → "tcichemicals.com"
 */
export function normalizeWebsite(input: string): string {
  if (!input) return '';

  // Add protocol if missing (for URL parsing)
  let url = input.trim().toLowerCase();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    const parsed = new URL(url);
    // Remove www. prefix and return hostname only
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    // If URL parsing fails, do basic cleanup
    return input
      .replace(/^(https?:\/\/)?(www\.)?/, '')
      .split('/')[0]
      .toLowerCase()
      .trim();
  }
}

/**
 * Extract domain from email address
 * Example: "john@tcichemicals.com" → "tcichemicals.com"
 */
export function extractEmailDomain(email: string): string | null {
  if (!email || !email.includes('@')) return null;
  const parts = email.split('@');
  return parts[1]?.toLowerCase().trim() || null;
}
