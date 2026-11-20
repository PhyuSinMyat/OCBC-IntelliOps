
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError, ProgrammingError
import os

from shared.database import Base, engine
import models  # Register all domain tables before creating metadata.

from modules.payment_processing.router import router as payment_router
from modules.payment_processing.api import router as payments_api
from modules.core_banking.router import router as core_banking_router
from modules.intelliops.router import router as intelliops_router
from modules.intelliops.investigation_router import router as investigation_router
from modules.intelliops.resolution_router import router as resolution_router

import modules.core_banking.snapshot  # Register the cross-portal snapshot route.


# Initialize FastAPI
app = FastAPI(title="OCBC IntelliOps API")


# --------------------------------------------------
# CORS Configuration
# Allow the local React frontend to access FastAPI
# --------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(dict.fromkeys([
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        *[value.strip().rstrip('/') for value in os.getenv('INTELLIOPS_FRONTEND_ORIGINS', '').split(',') if value.strip()],
    ])),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Investigation-Request-ID"],
)


@app.exception_handler(OperationalError)
async def database_unavailable(request, error):
    return JSONResponse(status_code=503, content={
        'code': 'DATABASE_UNAVAILABLE',
        'detail': 'FastAPI is running but could not connect to PostgreSQL. Check database availability, network access and backend configuration, then retry. Browser-only records were not substituted.',
    })


@app.exception_handler(ProgrammingError)
async def database_query_failed(request, error):
    if getattr(error.orig, 'pgcode', None) in {'42P01', '42703'}:
        return JSONResponse(status_code=503, content={
            'code': 'DATABASE_SCHEMA_OUTDATED',
            'detail': 'The database schema is missing a required table or column. Review the deployed Alembic revision before applying the pending migration. No migration was run automatically.',
        })
    return JSONResponse(status_code=500, content={'code': 'DATABASE_QUERY_FAILED', 'detail': 'FastAPI could not read the database records. Check the backend configuration.'})


# Register API routers
app.include_router(payment_router)
app.include_router(payments_api)
app.include_router(core_banking_router)
app.include_router(intelliops_router)
app.include_router(investigation_router)
app.include_router(resolution_router)


# Preserve existing Alembic history. Future schema changes use separately
# approved backend/sql scripts; startup never applies schema changes.


@app.get("/")
def home():
    return {
        "project": "OCBC IntelliOps",
        "status": "Backend running"
    }


@app.get("/health")
def health():
    return {"status": "healthy"}
