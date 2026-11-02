from alembic import context
from shared.database import Base, engine
import models

if context.is_offline_mode():
    context.configure(url=str(engine.url), target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    provided = context.config.attributes.get("connection")
    if provided is not None:
        context.configure(connection=provided, target_metadata=Base.metadata)
        with context.begin_transaction():
            context.run_migrations()
    else:
        with engine.connect() as connection:
            context.configure(connection=connection, target_metadata=Base.metadata)
            with context.begin_transaction():
                context.run_migrations()
