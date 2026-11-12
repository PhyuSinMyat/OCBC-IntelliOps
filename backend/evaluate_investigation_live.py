"""Explicit, single-call live evaluation. Never runs during normal unit tests.

An attempt marker prevents accidental repeat spending; there are no automatic retries.
Only the existing read-only investigation endpoint is invoked, never source mutations.
"""
import argparse
import json
import os
from pathlib import Path
import urllib.request
import urllib.error
from uuid import uuid4
from shared.database import engine  # Loads backend/.env deterministically; no DB query here.


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', required=True, choices=['CASE-000010', 'CASE-000011', 'CASE-000009'])
    parser.add_argument('--allow-paid', action='store_true')
    parser.add_argument('--api-url', default='http://127.0.0.1:8000')
    parser.add_argument('--output-dir', default=str(Path(__file__).resolve().parents[1] / 'logs' / 'phase2-live'))
    args = parser.parse_args()
    if not args.allow_paid:
        parser.error('A live provider call requires --allow-paid. Unit tests use mocked providers.')
    directory = Path(args.output_dir); directory.mkdir(parents=True, exist_ok=True)
    target = directory / (args.case + '.json')
    marker = directory / (args.case + '.attempt')
    # Reserve before sending. A timeout is ambiguous and must never trigger a blind retry.
    with marker.open('x', encoding='utf-8') as output:
        output.write('One explicit live attempt reserved. Inspect result before any new evaluation.\n')
    request = urllib.request.Request(args.api_url.rstrip('/') + '/api/exceptions/' + args.case + '/investigations',
        headers={'Authorization': 'Bearer ' + os.environ['INTELLIOPS_ADMIN_TOKEN'],
                 'X-Investigation-Request-ID': str(uuid4())}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=150) as response:
            body = json.load(response); status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
        try: body = json.load(error)
        except ValueError: body = {'detail': 'Non-JSON response; inspect backend without exposing credentials.'}
    except (TimeoutError, OSError):
        body, status = {'detail': 'Network result unknown. Do not retry automatically.'}, None
    result = dict(caseId=args.case, httpStatus=status, succeeded=status == 200, response=body)
    target.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'caseId': args.case, 'httpStatus': status, 'succeeded': status == 200,
        'metadata': body.get('provider_metadata', {}), 'resultPath': str(target)}))
    return 0 if status == 200 else 1


if __name__ == '__main__':
    raise SystemExit(main())
