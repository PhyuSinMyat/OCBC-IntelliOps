from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class CustomerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    customer_id: UUID
    customer_ref: str
    customer_name: str
    customer_type: Literal["INDIVIDUAL", "BUSINESS"]
    status: str
    created_at: datetime


class AccountInput(BaseModel):
    customer_id: UUID
    account_type: Literal["SAVINGS", "CURRENT"]
    currency: str = Field(pattern=r"^[A-Z]{3}$")


class BalanceOut(BaseModel):
    opening_balance: Decimal
    posted_credits: Decimal
    posted_debits: Decimal
    net_change: Decimal
    current_balance: Decimal


class AccountOut(BaseModel):
    account_id: UUID
    account_ref: str
    account_type: Literal["SAVINGS", "CURRENT"]
    currency: str
    status: str
    created_at: datetime
    customer: CustomerOut
    balance: BalanceOut


class AccountPage(BaseModel):
    items: list[AccountOut]
    total: int
    page: int
    page_size: int


class EntryOut(BaseModel):
    entry_id: UUID
    journal_reference: str
    payment_reference: str | None
    payment_available: bool
    description: str
    posted_at: datetime
    side: Literal["Debit", "Credit"]
    amount: Decimal
    signed_amount: Decimal
    currency: str
