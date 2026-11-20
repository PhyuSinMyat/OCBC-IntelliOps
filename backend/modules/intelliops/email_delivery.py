"""Backend-only SMTP delivery for persisted customer communications."""
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
import os
import smtplib
import ssl


class EmailConfigurationError(ValueError):
    pass


class EmailSendError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _flag(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() == "true"


def _address(value: str, label: str) -> str:
    if not value or any(char in value for char in "\r\n"):
        raise EmailConfigurationError(f"{label} is invalid.")
    _, parsed = parseaddr(value)
    if parsed != value.strip() or "@" not in parsed or parsed.startswith("@") or parsed.endswith("@"):
        raise EmailConfigurationError(f"{label} is invalid.")
    return parsed


@dataclass(frozen=True)
class SmtpSettings:
    host: str
    port: int
    security: str
    username: str | None
    password: str | None
    from_email: str
    from_name: str
    reply_to: str | None
    timeout: float
    allowed_domains: frozenset[str]

    @classmethod
    def load(cls):
        if not _flag("INTELLIOPS_EMAIL_ENABLED"):
            raise EmailConfigurationError("Outbound customer email is not enabled.")
        host = os.getenv("INTELLIOPS_SMTP_HOST", "").strip()
        if not host:
            raise EmailConfigurationError("INTELLIOPS_SMTP_HOST is required.")
        try:
            port = int(os.getenv("INTELLIOPS_SMTP_PORT", "587"))
            timeout = float(os.getenv("INTELLIOPS_SMTP_TIMEOUT_SECONDS", "15"))
        except ValueError as error:
            raise EmailConfigurationError("SMTP port and timeout must be numeric.") from error
        if not 1 <= port <= 65535 or not 1 <= timeout <= 60:
            raise EmailConfigurationError("SMTP port or timeout is outside the allowed range.")
        security = os.getenv("INTELLIOPS_SMTP_SECURITY", "STARTTLS").strip().upper()
        if security not in {"STARTTLS", "SSL", "NONE"}:
            raise EmailConfigurationError("INTELLIOPS_SMTP_SECURITY must be STARTTLS, SSL or NONE.")
        username = os.getenv("INTELLIOPS_SMTP_USERNAME", "").strip() or None
        password = os.getenv("INTELLIOPS_SMTP_PASSWORD") or None
        if bool(username) != bool(password):
            raise EmailConfigurationError("SMTP username and password must be configured together.")
        from_email = _address(os.getenv("INTELLIOPS_EMAIL_FROM", ""), "INTELLIOPS_EMAIL_FROM")
        reply = os.getenv("INTELLIOPS_EMAIL_REPLY_TO", "").strip() or None
        if reply:
            reply = _address(reply, "INTELLIOPS_EMAIL_REPLY_TO")
        domains = frozenset(value.strip().lower() for value in
            os.getenv("INTELLIOPS_EMAIL_ALLOWED_DOMAINS", "").split(",") if value.strip())
        return cls(host, port, security, username, password, from_email,
                   os.getenv("INTELLIOPS_EMAIL_FROM_NAME", "IntelliOps Operations").strip(),
                   reply, timeout, domains)

    def recipient(self, value: str) -> str:
        address = _address(value, "Recipient email")
        domain = address.rsplit("@", 1)[1].lower()
        if self.allowed_domains and domain not in self.allowed_domains:
            raise EmailConfigurationError("Recipient email domain is not allowed by the backend configuration.")
        return address


class SmtpMailer:
    def __init__(self, settings: SmtpSettings):
        self.settings = settings

    @classmethod
    def configured(cls):
        return cls(SmtpSettings.load())

    def validate_recipient(self, recipient: str) -> str:
        return self.settings.recipient(recipient)

    def message_id(self, token: str) -> str:
        return f"<{token}@{self.settings.from_email.rsplit('@', 1)[1]}>"

    def send(self, recipient: str, subject: str, body: str, message_id: str):
        if any(char in subject for char in "\r\n"):
            raise EmailConfigurationError("Email subject contains an invalid line break.")
        message = EmailMessage()
        message["From"] = formataddr((self.settings.from_name, self.settings.from_email))
        message["To"] = recipient
        message["Subject"] = subject
        message["Message-ID"] = message_id
        if self.settings.reply_to:
            message["Reply-To"] = self.settings.reply_to
        message.set_content(body)
        context = ssl.create_default_context()
        try:
            if self.settings.security == "SSL":
                client = smtplib.SMTP_SSL(self.settings.host, self.settings.port,
                                          timeout=self.settings.timeout, context=context)
            else:
                client = smtplib.SMTP(self.settings.host, self.settings.port, timeout=self.settings.timeout)
            with client:
                client.ehlo()
                if self.settings.security == "STARTTLS":
                    client.starttls(context=context)
                    client.ehlo()
                if self.settings.username:
                    client.login(self.settings.username, self.settings.password)
                refused = client.send_message(message)
                if refused:
                    raise EmailSendError("RECIPIENT_REFUSED")
        except EmailSendError:
            raise
        except smtplib.SMTPAuthenticationError as error:
            raise EmailSendError("AUTHENTICATION_FAILED") from error
        except smtplib.SMTPRecipientsRefused as error:
            raise EmailSendError("RECIPIENT_REFUSED") from error
        except (smtplib.SMTPException, OSError, TimeoutError) as error:
            raise EmailSendError("SMTP_DELIVERY_FAILED") from error


def get_mailer():
    try:
        return SmtpMailer.configured()
    except EmailConfigurationError:
        return None
