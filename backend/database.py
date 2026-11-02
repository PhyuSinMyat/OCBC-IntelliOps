"""Compatibility exports for existing scripts."""
from shared.database import Base, engine, SessionLocal

__all__ = ["Base", "engine", "SessionLocal"]
