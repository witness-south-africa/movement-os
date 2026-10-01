#!/usr/bin/env python3
"""Capture structural extract-API proof without printing bodies or credentials."""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # Keep signed headers and the observation bound to the named endpoint.
        return None


def nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def iso_timestamp(value):
    if not isinstance(value, str) or re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', value) is None:
        return False
    try:
        datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return True
    except ValueError:
        return False


def complete_claim(item):
    if not isinstance(item, dict):
        return False
    claim, evidence, promotion = (item.get(name) for name in ('claim', 'evidencePreview', 'promotionDecision'))
    if not all(isinstance(value, dict) for value in (claim, evidence, promotion)):
        return False
    statuses = {'conclusive', 'high-confidence', 'contested', 'insufficient-record', 'destroyed-or-missing-record-suspected'}
    source = claim.get('sourceRef')
    reasons = promotion.get('reasons')
    time_fields_present = (iso_timestamp(claim.get('assertedAt'))
                           and all(name in claim and (claim[name] is None or iso_timestamp(claim[name]))
                                   for name in ('validFrom', 'validTo')))
    return (item.get('requestedStatus') in statuses
            and item.get('effectiveStatus') in statuses
            and claim.get('status') == item['effectiveStatus']
            and all(nonempty_string(claim.get(name)) for name in ('id', 'text'))
            and claim.get('extractedBy') in {'agent:evidence-engine', 'agent:evidence-intake', 'agent:source-verifier', 'human'}
            and time_fields_present
            and isinstance(source, dict) and source.get('kind') in {'artefact', 'intake'}
            and nonempty_string(source.get('id'))
            and all(nonempty_string(evidence.get(name)) for name in ('id', 'kind', 'url', 'fetchedAt', 'sha256', 'supports'))
            and re.fullmatch(r'[a-fA-F0-9]{64}', evidence['sha256']) is not None
            and iso_timestamp(evidence.get('fetchedAt'))
            and evidence.get('kind') in {'court-record', 'government-publication', 'statssa', 'commission', 'news-article', 'other'}
            and evidence.get('supports') in {'supports', 'contradicts', 'inconclusive'}
            and isinstance(promotion.get('ok'), bool)
            and isinstance(reasons, list)
            and all(isinstance(reason, dict) and nonempty_string(reason.get('code'))
                    and reason.get('severity') in {'warn', 'block'} for reason in reasons))


def capture(url, mode, body=b'{}', key_id=None, secret=None):
    envelope = json.loads(body)
    extract = envelope.get('extract') if isinstance(envelope, dict) else None
    request_id = extract.get('requestId') if isinstance(extract, dict) else None
    if mode != 'unsigned' and not nonempty_string(request_id):
        raise ValueError('valid extract.requestId required before sending')
    headers = {'Content-Type': 'application/json'}
    if mode != 'unsigned':
        if not key_id or not secret:
            raise ValueError('operator credentials required')
        timestamp = str(int(time.time()))
        body_hash = hashlib.sha256(body).hexdigest()
        target = urllib.parse.urlsplit(url)
        path = (target.path or '/') + ('?' + target.query if target.query else '')
        canonical = '\n'.join(['POST', path, timestamp, body_hash])
        signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        if mode == 'tampered':
            signature = ('0' if signature[0] != '0' else '1') + signature[1:]
        headers.update({'X-WSA-Key-Id': key_id, 'X-WSA-Timestamp': timestamp,
                        'X-WSA-Content-SHA256': body_hash, 'X-WSA-Signature': signature})
    request = urllib.request.Request(url, data=body, headers=headers, method='POST')
    try:
        response = urllib.request.build_opener(NoRedirects).open(request, timeout=60)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = response.code
        raw = response.read()
    payload = json.loads(raw)
    claims = payload.get('claims', []) if isinstance(payload, dict) else []
    if not isinstance(claims, list):
        claims = []
    promotion_present = bool(claims) and all(
        isinstance(claim, dict) and isinstance(claim.get('promotionDecision'), dict)
        and isinstance(claim['promotionDecision'].get('ok'), bool) for claim in claims)
    claim_shape_complete = bool(claims) and all(complete_claim(claim) for claim in claims)
    response_id_matches = isinstance(payload, dict) and nonempty_string(request_id) and payload.get('requestId') == request_id
    reason = payload.get('reason') if isinstance(payload, dict) else None
    # Only known response categories may leave the private response boundary.
    safe_reason = reason if reason in {'missing_signature_headers', 'signature_mismatch',
                                      'body_hash_mismatch', 'stale_timestamp', 'unknown_key_id',
                                      'budget_exhausted', 'rate_limited', 'internal_error'} else None
    no_attribution = re.search(r'grok|xai|x\.ai', json.dumps(payload, ensure_ascii=False), re.IGNORECASE) is None
    summary_present = isinstance(payload, dict) and isinstance(payload.get('summary'), str) and bool(payload['summary'].strip())
    auth_reasons = {'missing_signature_headers', 'signature_mismatch', 'body_hash_mismatch', 'stale_timestamp', 'unknown_key_id'}
    accepted = no_attribution and ((mode == 'signed' and status == 200 and promotion_present and claim_shape_complete and response_id_matches and summary_present)
                or (mode in {'unsigned', 'tampered'} and status == 401 and safe_reason in auth_reasons)
                or (mode == 'budget' and status == 429 and safe_reason == 'budget_exhausted'))
    return {'capturedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'mode': mode, 'status': status, 'reason': safe_reason,
            'requestIdSha256': hashlib.sha256(request_id.encode()).hexdigest() if isinstance(request_id, str) else None,
            'responseSha256': hashlib.sha256(raw).hexdigest(),
            'summaryPresent': summary_present,
            'responseRequestIdMatches': response_id_matches,
            'claimShapeComplete': claim_shape_complete,
            'claimCount': len(claims), 'promotionPresent': promotion_present,
            'noProviderAttribution': no_attribution, 'accepted': accepted}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--mode', choices=['unsigned', 'tampered', 'signed', 'budget'], required=True)
    parser.add_argument('--envelope', help='Private Lane-2 request JSON file')
    parser.add_argument('--allow-provider-call', action='store_true',
                        help='Explicitly allow one potentially paid call in signed/budget mode')
    args = parser.parse_args(argv)
    if args.mode in {'signed', 'budget'} and not args.allow_provider_call:
        parser.error('signed/budget mode requires --allow-provider-call')
    if args.mode != 'unsigned' and not args.envelope:
        parser.error('signed/tampered/budget mode requires --envelope')
    if urllib.parse.urlsplit(args.url).scheme != 'https':
        parser.error('an HTTPS operator endpoint is required')
    try:
        body = b'{}'
        if args.envelope:
            with open(args.envelope, 'rb') as envelope:
                body = envelope.read()
        key_id = os.environ.get('EXTRACT_OPERATOR_KEY_ID')
        canonical_id = re.sub(r'[^A-Za-z0-9_]', '_', key_id or '')
        secret = os.environ.get('OPERATOR_HMAC_KEY_' + canonical_id)
        result = capture(args.url, args.mode, body, key_id, secret)
        print(json.dumps(result, indent=2))
        return 0 if result['accepted'] else 1
    except Exception:
        # HTTP/JSON/credential exceptions can contain raw bodies or headers.
        print('probe failed; no response body or credentials emitted', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
