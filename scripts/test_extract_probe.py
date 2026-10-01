import hashlib
import hmac
import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import extract_probe


class FakeResponse(io.BytesIO):
    code = 200


class ProbeTests(unittest.TestCase):
    def signed_body(self):
        return b'{"extract":{"requestId":"probe-001"}, "sourceText":"private synthetic body"}'

    def response_body(self):
        return {'requestId': 'probe-001', 'summary': 'private output', 'claims': [{
            'requestedStatus': 'contested', 'effectiveStatus': 'contested',
            'claim': {'id': 'claim-id', 'text': 'private claim', 'status': 'contested', 'sourceRef': {'kind': 'artefact', 'id': 'source-id'}},
            'evidencePreview': {'id': 'evidence-id', 'kind': 'other', 'url': 'https://example.org/source', 'fetchedAt': '2026-10-01T08:00:00Z', 'sha256': 'a' * 64, 'supports': 'supports'},
            'promotionDecision': {'ok': True, 'reasons': []}}]}

    def test_signed_probe_preserves_raw_path_and_emits_only_structural_evidence(self):
        body = self.signed_body()
        response = self.response_body()
        raw = json.dumps(response).encode()
        with patch('extract_probe.time.time', return_value=123), patch('extract_probe.urllib.request.OpenerDirector.open', return_value=FakeResponse(raw)) as send:
            result = extract_probe.capture('https://operator.invalid/v1/extract?source=%2Fdoc', 'signed', body, 'OPS-01', 'test-secret')
        request = send.call_args.args[0]
        canonical = 'POST\n/v1/extract?source=%2Fdoc\n123\n' + hashlib.sha256(body).hexdigest()
        self.assertEqual(request.get_header('X-wsa-signature'), hmac.new(b'test-secret', canonical.encode(), hashlib.sha256).hexdigest())
        self.assertTrue(result['accepted'])
        self.assertEqual(result['responseSha256'], hashlib.sha256(raw).hexdigest())
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('test-secret', json.dumps(result))

    def test_provider_attribution_prevents_acceptance(self):
        response = self.response_body()
        response['summary'] = 'Grok'
        with patch('extract_probe.urllib.request.OpenerDirector.open', return_value=FakeResponse(json.dumps(response).encode())):
            result = extract_probe.capture('https://operator.invalid/v1/extract', 'signed', self.signed_body(), 'OP01', 'test-secret')
        self.assertFalse(result['accepted'])
        self.assertFalse(result['noProviderAttribution'])

    def test_escaped_provider_attribution_is_detected_after_json_decoding(self):
        response = self.response_body()
        raw = json.dumps(response).replace('private output', r'\u0078\u0061\u0069').encode()
        with patch('extract_probe.urllib.request.OpenerDirector.open', return_value=FakeResponse(raw)):
            result = extract_probe.capture('https://operator.invalid/v1/extract', 'signed', self.signed_body(), 'OP01', 'test-secret')
        self.assertFalse(result['accepted'])
        self.assertFalse(result['noProviderAttribution'])

    def test_response_must_match_request_and_include_complete_claim_structure(self):
        for missing in ('claim', 'evidencePreview', 'requestedStatus', 'effectiveStatus', 'promotionDecision'):
            with self.subTest(missing=missing):
                response = self.response_body()
                del response['claims'][0][missing]
                with patch('extract_probe.urllib.request.OpenerDirector.open', return_value=FakeResponse(json.dumps(response).encode())):
                    result = extract_probe.capture('https://operator.invalid/v1/extract', 'signed', self.signed_body(), 'OP01', 'test-secret')
                self.assertFalse(result['accepted'])
        response = self.response_body()
        response['requestId'] = 'different-request'
        with patch('extract_probe.urllib.request.OpenerDirector.open', return_value=FakeResponse(json.dumps(response).encode())):
            result = extract_probe.capture('https://operator.invalid/v1/extract', 'signed', self.signed_body(), 'OP01', 'test-secret')
        self.assertFalse(result['accepted'])
        self.assertFalse(result['responseRequestIdMatches'])

    def test_invalid_request_ids_are_rejected_before_network(self):
        with patch('extract_probe.urllib.request.OpenerDirector.open') as send:
            for body in (b'{}', b'[]', b'{"extract":{}}', b'{"extract":{"requestId":" "}}', b'{"extract":{"requestId":1}}'):
                with self.subTest(body=body), self.assertRaises(ValueError):
                    extract_probe.capture('https://operator.invalid/v1/extract', 'signed', body, 'OP01', 'test-secret')
        send.assert_not_called()

    def test_budget_http_error_response_is_captured_without_body_leakage(self):
        error = extract_probe.urllib.error.HTTPError('https://operator.invalid', 429, 'private error', {}, io.BytesIO(b'{"reason":"budget_exhausted"}'))
        with patch('extract_probe.urllib.request.OpenerDirector.open', side_effect=error):
            result = extract_probe.capture('https://operator.invalid/v1/extract', 'budget', self.signed_body(), 'OP01', 'test-secret')
        self.assertTrue(result['accepted'])
        self.assertNotIn('private error', json.dumps(result))

    def test_unknown_reason_cannot_leak_into_evidence(self):
        response = FakeResponse(b'{"reason":"private-secret"}')
        response.code = 401
        with patch('extract_probe.urllib.request.OpenerDirector.open', return_value=response):
            result = extract_probe.capture('https://operator.invalid/v1/extract', 'unsigned')
        self.assertIsNone(result['reason'])
        self.assertFalse(result['accepted'])

    def test_spend_requires_explicit_flag_before_network(self):
        with patch('extract_probe.urllib.request.OpenerDirector.open') as send, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                extract_probe.main(['--url', 'https://operator.invalid/v1/extract', '--mode', 'budget'])
        send.assert_not_called()

    def test_redirects_do_not_forward_signed_credentials(self):
        handler = extract_probe.NoRedirects()
        self.assertIsNone(handler.redirect_request(None, None, 302, '', {}, 'https://elsewhere.invalid'))

    def test_failures_do_not_print_exception_details(self):
        out, err = io.StringIO(), io.StringIO()
        with patch('extract_probe.capture', side_effect=ValueError('private-secret')), redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(extract_probe.main(['--url', 'https://operator.invalid/v1/extract', '--mode', 'unsigned']), 1)
        self.assertNotIn('private-secret', out.getvalue() + err.getvalue())


if __name__ == '__main__':
    unittest.main()
