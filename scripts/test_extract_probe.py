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
    def test_signed_probe_preserves_raw_path_and_emits_only_structural_evidence(self):
        body = b'{"sourceText":"private synthetic body"}'
        response = {'summary': 'private output', 'claims': [{'text': 'private claim', 'promotionDecision': {'ok': True}}]}
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
        with patch('extract_probe.urllib.request.OpenerDirector.open', return_value=FakeResponse(b'{"summary":"Grok", "claims":[{"promotionDecision":{"ok":true}}]}')):
            result = extract_probe.capture('https://operator.invalid/v1/extract', 'signed', b'{}', 'OP01', 'test-secret')
        self.assertFalse(result['accepted'])
        self.assertFalse(result['noProviderAttribution'])

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
