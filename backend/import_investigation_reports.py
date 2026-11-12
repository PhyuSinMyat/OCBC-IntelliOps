"""Explicit approved-development import of previously accepted reports. No OpenAI calls."""
import argparse
import json
from pathlib import Path
from shared.database import SessionLocal, database_url
import models  # Register existing schema; never creates it.
from modules.intelliops.investigation_storage import import_accepted_report, require_enabled


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report-files', nargs='+', required=True)
    parser.add_argument('--confirm-host', required=True)
    parser.add_argument('--confirm-database', required=True)
    parser.add_argument('--allow-development-write', action='store_true')
    args = parser.parse_args()
    if not args.allow_development_write:
        parser.error('Explicit separate approval is required before importing into development storage.')
    if database_url.get_backend_name() != 'postgresql' or args.confirm_host != database_url.host or args.confirm_database != database_url.database:
        parser.error('Confirmed PostgreSQL target does not match backend configuration.')
    require_enabled()
    for name in args.report_files:
        source = json.loads(Path(name).read_text(encoding='utf-8'))
        if source.get('httpStatus') != 200 or not source.get('succeeded'):
            parser.error('Source must be a successful saved backend evaluation result.')
        with SessionLocal() as db:
            status, report = import_accepted_report(db, source['response'])
        print(json.dumps(dict(case_id=report.get('case_id'), investigation_id=report.get('investigation_id'), status=status)))


if __name__ == '__main__': main()
