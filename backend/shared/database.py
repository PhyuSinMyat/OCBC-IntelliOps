import os
from pathlib import Path
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# Resolve configuration independently of the command's working directory. Explicit
# process variables still win, including disposable test database URLs.
load_dotenv(Path(__file__).resolve().parents[1] / '.env', override=False)

DATABASE_URL = os.environ["DATABASE_URL"]
database_url = make_url(DATABASE_URL)
connection_args = {}
pool_options = {}
if database_url.get_backend_name() == 'postgresql':
    connection_args = {'connect_timeout': 5, 'application_name': 'ocbc-intelliops'}
    if 'supabase.' in (database_url.host or '') and 'sslmode' not in database_url.query:
        connection_args['sslmode'] = 'require'
    pool_options = dict(pool_size=5, max_overflow=5, pool_timeout=10, pool_recycle=300)

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args=connection_args,
    **pool_options,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False
)

class Base(DeclarativeBase):
    pass
