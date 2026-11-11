"""Browser fixture: isolated memory or an explicitly disposable local PostgreSQL schema."""
import os
import sys
from pathlib import Path
from uuid import uuid4
import atexit
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["INTELLIOPS_ADMIN_TOKEN"] = "integration-test-admin-only"
os.environ["INTELLIOPS_ANALYST_TOKEN"] = "integration-test-analyst-only"
os.environ["INTELLIOPS_SIMULATION_TIME"] = "2026-11-03T03:00:00+00:00"
os.environ['INTELLIOPS_ENVIRONMENT'] = 'test'
os.environ['INTELLIOPS_ENABLE_RETRY_FAULT'] = 'true'
os.environ['INTELLIOPS_SYNTHETIC_ACCOUNT_REFS'] = 'ACC-100003,ACC-100001'

import uvicorn
from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session
from alembic import command
from alembic.config import Config
from main import app
from modules.core_banking.router import get_db
from modules.core_banking.seed import seed_demo

postgres_url = os.getenv('INTELLIOPS_TEST_POSTGRES_URL')
if postgres_url:
    parsed = make_url(postgres_url)
    if (parsed.get_backend_name() != 'postgresql' or parsed.host not in {'127.0.0.1', 'localhost', '::1'}
            or not (parsed.database or '').endswith('_test') or set(parsed.query) - {'sslmode'}):
        raise RuntimeError('Browser tests require an explicit disposable loopback PostgreSQL *_test database.')
    schema = 'intelliops_browser_' + uuid4().hex
    control = create_engine(parsed)
    with control.begin() as conn:
        conn.execute(CreateSchema(schema))
    engine = create_engine(parsed, connect_args={'options': f'-csearch_path={schema},pg_catalog', 'connect_timeout': 5})
    def cleanup():
        engine.dispose()
        with control.begin() as conn:
            conn.execute(DropSchema(schema, cascade=True))
        control.dispose()
    atexit.register(cleanup)
else:
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
with engine.begin() as connection:
    config.attributes["connection"] = connection
    command.upgrade(config, "head")
with Session(engine) as db, db.begin():
    seed_demo(db)

def test_db():
    with Session(engine) as db:
        yield db
app.dependency_overrides[get_db] = test_db

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8191, log_level="warning")
