"""Loopback-only browser integration fixture; all records live in isolated memory."""
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["INTELLIOPS_ADMIN_TOKEN"] = "integration-test-admin-only"
os.environ["INTELLIOPS_ANALYST_TOKEN"] = "integration-test-analyst-only"
os.environ["INTELLIOPS_SIMULATION_TIME"] = "2026-11-03T03:00:00+00:00"

import uvicorn
from sqlalchemy import create_engine, event
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session
from alembic import command
from alembic.config import Config
from main import app
from modules.core_banking.router import get_db
from modules.core_banking.seed import seed_demo

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
