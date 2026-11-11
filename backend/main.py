from fastapi import FastAPI
from shared.database import Base, engine
import models  # Register all domain tables before creating metadata.
from modules.payment_processing.router import router as payment_router
from modules.payment_processing.api import router as payments_api
from modules.core_banking.router import router as core_banking_router
from modules.intelliops.router import router as intelliops_router
from modules.intelliops.investigation_router import router as investigation_router
import modules.core_banking.snapshot  # Register the cross-portal snapshot route.

app = FastAPI(title="OCBC IntelliOps API")
app.include_router(payment_router)
app.include_router(payments_api)
app.include_router(core_banking_router)
app.include_router(intelliops_router)
app.include_router(investigation_router)

# Apply schema changes explicitly with `alembic upgrade head` before startup.


@app.get("/")
def home():
    return {
        "project": "OCBC IntelliOps",
        "status": "Backend running"
    }


@app.get("/health")
def health():
    return {"status": "healthy"}
