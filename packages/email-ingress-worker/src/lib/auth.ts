const AUTH_RESULT_PATTERN =
  /\b(pass|fail|softfail|neutral|none|temperror|permerror)\b/i;
const AUTH_MECHANISM_PATTERNS = {
  spf: /\bspf=([^;\s]+)/i,
  dkim: /\bdkim=([^;\s]+)/i,
  dmarc: /\bdmarc=([^;\s]+)/i,
};

export type MailAuthVerdict =
  | 'pass'
  | 'fail'
  | 'softfail'
  | 'neutral'
  | 'none'
  | 'temperror'
  | 'permerror'
  | 'unknown';

export interface MailAuthenticationVerdicts {
  readonly spf: MailAuthVerdict;
  readonly dkim: MailAuthVerdict;
  readonly dmarc: MailAuthVerdict;
}

function parseVerdict(value: string | null): MailAuthVerdict {
  if (!value) {
    return 'unknown';
  }
  const match = AUTH_RESULT_PATTERN.exec(value);
  const verdict = match?.[1];
  return verdict ? (verdict.toLowerCase() as MailAuthVerdict) : 'unknown';
}

function extractHeader(headers: Headers, name: string): string | null {
  return headers.get(name);
}

function extractAuthResult(
  authenticationResults: string | null,
  mechanism: keyof typeof AUTH_MECHANISM_PATTERNS,
): MailAuthVerdict {
  if (!authenticationResults) {
    return 'unknown';
  }

  const match = AUTH_MECHANISM_PATTERNS[mechanism].exec(authenticationResults);
  return parseVerdict(match?.[1] ?? null);
}

export function parseAuthenticationVerdicts(
  headers: Headers,
): MailAuthenticationVerdicts {
  const authenticationResults = extractHeader(
    headers,
    'authentication-results',
  );
  const receivedSpf = extractHeader(headers, 'received-spf');

  const spfVerdict = extractAuthResult(authenticationResults, 'spf');

  return {
    spf: spfVerdict === 'unknown' ? parseVerdict(receivedSpf) : spfVerdict,
    dkim: extractAuthResult(authenticationResults, 'dkim'),
    dmarc: extractAuthResult(authenticationResults, 'dmarc'),
  };
}
