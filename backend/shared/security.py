"""Small explicit demo credential boundary; roles are never trusted from a header."""
import os
import secrets
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

bearer = HTTPBearer(auto_error=False)


def actor(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if credentials and credentials.scheme.lower() == "bearer":
        for role in ("ADMIN", "ANALYST"):
            expected = os.getenv(f"INTELLIOPS_{role}_TOKEN", "")
            if expected and secrets.compare_digest(credentials.credentials, expected):
                return role
    raise HTTPException(401, "Supply a configured synthetic-demo bearer token.", headers={"WWW-Authenticate": "Bearer"})


def administrator(role=Depends(actor)):
    if role != "ADMIN":
        raise HTTPException(403, "Only ADMIN may inject exception scenarios.")
    return role
