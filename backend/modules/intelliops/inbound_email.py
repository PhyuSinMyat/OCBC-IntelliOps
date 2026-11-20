"""Read-only Gmail IMAP adapter for importing customer replies."""
from dataclasses import dataclass
from datetime import datetime, timezone
from email import message_from_bytes, policy
from email.utils import parsedate_to_datetime, parseaddr
import imaplib
import os
import re


class InboundEmailConfigurationError(ValueError):
    pass


class InboundEmailSyncError(RuntimeError):
    pass


def _flag(name, default="false"):
    return os.getenv(name, default).strip().lower() == "true"


def _email_address(value):
    _, address = parseaddr(value or "")
    return address.strip().lower()


@dataclass(frozen=True)
class ImapSettings:
    host: str
    port: int
    username: str
    password: str
    mailbox: str
    timeout: float
    lookback_days: int
    max_messages: int

    @classmethod
    def load(cls):
        if not _flag("INTELLIOPS_INBOUND_EMAIL_ENABLED"):
            raise InboundEmailConfigurationError("Inbound Gmail synchronization is not enabled.")
        host = os.getenv("INTELLIOPS_IMAP_HOST", "imap.gmail.com").strip()
        username = (os.getenv("INTELLIOPS_IMAP_USERNAME", "").strip() or
                    os.getenv("INTELLIOPS_SMTP_USERNAME", "").strip())
        password = (os.getenv("INTELLIOPS_IMAP_PASSWORD") or
                    os.getenv("INTELLIOPS_SMTP_PASSWORD") or "")
        mailbox = os.getenv("INTELLIOPS_IMAP_MAILBOX", "INBOX").strip()
        try:
            port = int(os.getenv("INTELLIOPS_IMAP_PORT", "993"))
            timeout = float(os.getenv("INTELLIOPS_IMAP_TIMEOUT_SECONDS", "20"))
            lookback = int(os.getenv("INTELLIOPS_IMAP_LOOKBACK_DAYS", "30"))
            maximum = int(os.getenv("INTELLIOPS_IMAP_MAX_MESSAGES", "100"))
        except ValueError as error:
            raise InboundEmailConfigurationError("IMAP numeric settings are invalid.") from error
        if not host or not username or not password or not mailbox:
            raise InboundEmailConfigurationError("IMAP host, username, password and mailbox are required.")
        if not 1 <= port <= 65535 or not 1 <= timeout <= 60 or not 1 <= lookback <= 90 or not 1 <= maximum <= 500:
            raise InboundEmailConfigurationError("IMAP settings are outside their allowed ranges.")
        return cls(host, port, username, password, mailbox, timeout, lookback, maximum)


@dataclass(frozen=True)
class InboundMessage:
    provider_message_id: str
    mailbox_uid: str
    sender_email: str
    subject: str | None
    body: str
    in_reply_to: str
    references: tuple[str, ...]
    received_at: datetime


_message_id = re.compile(r"<[^<>\s]{1,250}>")


def _reply_ids(message):
    values = " ".join(filter(None, [str(message.get("In-Reply-To", "")), str(message.get("References", ""))]))
    return tuple(dict.fromkeys(_message_id.findall(values)))


def _plain_body(message):
    if message.is_multipart():
        parts = [part for part in message.walk() if part.get_content_type() == "text/plain"
                 and part.get_content_disposition() != "attachment"]
        text = "\n".join(str(part.get_content()) for part in parts)
    elif message.get_content_type() == "text/plain":
        text = str(message.get_content())
    else:
        return ""
    lines = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.startswith(">") or re.match(r"^On .+ wrote:\s*$", line.strip(), re.I):
            break
        if line.strip() == "--":
            break
        lines.append(line.rstrip())
    return "\n".join(lines).strip()[:5000]


def _received_at(value):
    try:
        parsed = parsedate_to_datetime(value) if value else None
        if parsed:
            return (parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed).astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        pass
    return datetime.now(timezone.utc)


class GmailImapMailbox:
    def __init__(self, settings):
        self.settings = settings

    @classmethod
    def configured(cls):
        return cls(ImapSettings.load())

    def scan(self, since):
        client = None
        try:
            client = imaplib.IMAP4_SSL(self.settings.host, self.settings.port, timeout=self.settings.timeout)
            client.login(self.settings.username, self.settings.password)
            status, _ = client.select(self.settings.mailbox, readonly=True)
            if status != "OK":
                raise InboundEmailSyncError("Gmail mailbox could not be opened.")
            search_since = since.strftime("%d-%b-%Y")
            status, data = client.uid("search", None, "SINCE", search_since)
            if status != "OK":
                raise InboundEmailSyncError("Gmail mailbox search failed.")
            uids = (data[0] or b"").split()[-self.settings.max_messages:]
            messages = []
            for uid in uids:
                status, payload = client.uid("fetch", uid, "(BODY.PEEK[])")
                if status != "OK":
                    continue
                raw = next((part[1] for part in payload if isinstance(part, tuple) and len(part) > 1), None)
                if not raw:
                    continue
                message = message_from_bytes(raw, policy=policy.default)
                reply_ids = _reply_ids(message)
                body = _plain_body(message)
                provider_id = str(message.get("Message-ID", "")).strip()
                if (not reply_ids or not body or not provider_id or len(provider_id) > 254
                        or "\r" in provider_id or "\n" in provider_id):
                    continue
                subject = str(message.get("Subject", "")).strip()[:200] or None
                messages.append(InboundMessage(provider_id, uid.decode("ascii", "ignore"),
                    _email_address(str(message.get("From", ""))), subject, body,
                    reply_ids[0], reply_ids, _received_at(str(message.get("Date", "")))))
            return messages
        except InboundEmailSyncError:
            raise
        except imaplib.IMAP4.error as error:
            raise InboundEmailSyncError("Gmail IMAP authentication or mailbox access failed.") from error
        except (OSError, TimeoutError) as error:
            raise InboundEmailSyncError("Gmail IMAP connection failed.") from error
        finally:
            if client is not None:
                try:
                    client.logout()
                except (imaplib.IMAP4.error, OSError):
                    pass


def get_inbound_mailbox():
    try:
        return GmailImapMailbox.configured()
    except InboundEmailConfigurationError:
        return None
