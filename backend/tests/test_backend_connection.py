"""Connection configuration and API failures; no shared database is contacted."""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError, ProgrammingError
from main import app
from modules.core_banking.router import get_db
from shared.security import actor


class BackendConnectionTests(unittest.TestCase):
    def tearDown(self):
        app.dependency_overrides.clear()

    def failed_snapshot(self, error):
        def unavailable():
            raise error
        app.dependency_overrides[get_db] = unavailable
        app.dependency_overrides[actor] = lambda: 'ADMIN'
        with TestClient(app) as client:
            return client.get('/api/banking-snapshot')

    def test_safe_connection_and_schema_errors(self):
        response = self.failed_snapshot(OperationalError('private query', {}, Exception('password=do-not-export')))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['code'], 'DATABASE_UNAVAILABLE')
        self.assertNotIn('do-not-export', response.text)
        driver = Exception('private schema details')
        driver.pgcode = '42703'
        response = self.failed_snapshot(ProgrammingError('private query', {}, driver))
        self.assertEqual(response.json()['code'], 'DATABASE_SCHEMA_OUTDATED')
        self.assertNotIn('private schema', response.text)

    def test_cors_accepts_configured_default_frontend_authorization(self):
        with TestClient(app) as client:
            response = client.options('/api/banking-snapshot', headers={'Origin': 'http://localhost:5173',
                'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['access-control-allow-origin'], 'http://localhost:5173')

    def test_database_configuration_is_cwd_independent_and_bounded(self):
        backend = str(Path(__file__).resolve().parents[1])
        code = """import sys,json,dotenv
seen=[]
dotenv.load_dotenv=lambda path,override: seen.append((str(path),override))
import shared.database as db
print(json.dumps(dict(path=seen[0][0],override=seen[0][1],args=db.connection_args,host=db.database_url.host,pool=db.engine.pool.size())))
"""
        env = {**os.environ, 'PYTHONPATH': backend, 'DATABASE_URL': 'postgresql+psycopg2://unused@unit.pooler.supabase.com/intelliops_test'}
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, '-B', '-c', code], cwd=directory, env=env, capture_output=True, text=True, check=True)
        configuration = json.loads(result.stdout)
        self.assertEqual(Path(configuration['path']), Path(backend) / '.env')
        self.assertFalse(configuration['override'])
        self.assertEqual(configuration['host'], 'unit.pooler.supabase.com')
        self.assertEqual(configuration['args']['connect_timeout'], 5)
        self.assertEqual(configuration['args']['sslmode'], 'require')
        self.assertEqual(configuration['pool'], 5)
