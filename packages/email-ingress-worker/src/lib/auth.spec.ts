import { parseAuthenticationVerdicts } from './auth.js';

describe('parseAuthenticationVerdicts', () => {
  it('extracts SPF, DKIM, and DMARC verdicts from Authentication-Results', () => {
    const headers = new Headers({
      'authentication-results':
        'mx.cloudflare.net; spf=pass smtp.mailfrom=example.org; dkim=pass header.d=example.org; dmarc=pass header.from=example.org',
    });

    expect(parseAuthenticationVerdicts(headers)).toStrictEqual({
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
    });
  });

  it('falls back to Received-SPF when Authentication-Results omits SPF', () => {
    const headers = new Headers({
      'authentication-results': 'mx.cloudflare.net; dkim=pass; dmarc=pass',
      'received-spf': 'pass (sender SPF authorized)',
    });

    expect(parseAuthenticationVerdicts(headers)).toStrictEqual({
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
    });
  });

  it('returns unknown verdicts when auth headers are absent', () => {
    expect(parseAuthenticationVerdicts(new Headers())).toStrictEqual({
      spf: 'unknown',
      dkim: 'unknown',
      dmarc: 'unknown',
    });
  });

  it('handles mixed case and keeps the first result for each mechanism', () => {
    const headers = new Headers({
      'authentication-results':
        'mx.example; SPF=SoftFail smtp.mailfrom=example.org; DKIM=TEMPERROR; DMARC=PermError; spf=pass',
    });

    expect(parseAuthenticationVerdicts(headers)).toStrictEqual({
      spf: 'softfail',
      dkim: 'temperror',
      dmarc: 'permerror',
    });
  });

  it.each([
    'xspf=pass; xdkim=pass; xdmarc=pass',
    'spf=; dkim=unrecognized; dmarc=',
    'spf=unrecognized; dkim=; dmarc=unrecognized',
  ])('keeps malformed or unrelated mechanisms unknown: %s', (value) => {
    const headers = new Headers({
      'authentication-results': value,
      'received-spf': 'neutral (synthetic fallback)',
    });

    expect(parseAuthenticationVerdicts(headers)).toStrictEqual({
      spf: 'neutral',
      dkim: 'unknown',
      dmarc: 'unknown',
    });
  });

  it('keeps mechanism verdicts isolated and stops at whitespace or semicolons', () => {
    const headers = new Headers({
      'authentication-results':
        'spf=fail smtp.mailfrom=example.org; dkim=none;dmarc=pass header.from=example.org',
      'received-spf': 'pass',
    });

    expect(parseAuthenticationVerdicts(headers)).toStrictEqual({
      spf: 'fail',
      dkim: 'none',
      dmarc: 'pass',
    });
  });
});
