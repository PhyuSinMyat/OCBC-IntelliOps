import unittest
from datetime import datetime, timezone
from email.message import EmailMessage
from unittest.mock import patch

from modules.intelliops.inbound_email import GmailImapMailbox, ImapSettings


class GmailReplyPollingTests(unittest.TestCase):
    def test_case_message_ids_narrow_search_before_full_message_fetch(self):
        reply_to = '<outgoing-case-message@example.test>'
        message = EmailMessage()
        message['Message-ID'] = '<customer-reply@example.test>'
        message['In-Reply-To'] = reply_to
        message['References'] = reply_to
        message['From'] = 'customer@example.com'
        message['Subject'] = 'Re: Payment review'
        message['Date'] = '20 Nov 2026 10:00:00 +0000'
        message.set_content('Please explain the next steps.')

        class Client:
            instance = None

            def __init__(self, *args, **kwargs):
                type(self).instance = self
                self.searches = []
                self.fetched = []

            def login(self, username, password): return 'OK', []
            def select(self, mailbox, readonly=False): return 'OK', []
            def uid(self, command, *args):
                if command == 'search':
                    self.searches.append(args)
                    return 'OK', [b'42']
                self.fetched.append(args[0])
                return 'OK', [(b'42 (BODY[] {1})', message.as_bytes())]
            def logout(self): return 'BYE', []

        settings = ImapSettings('imap.gmail.com', 993, 'operator@example.com', 'secret',
            'INBOX', 5, 30, 100)
        with patch('modules.intelliops.inbound_email.imaplib.IMAP4_SSL', Client):
            replies = GmailImapMailbox(settings).scan(datetime(2026, 10, 21, tzinfo=timezone.utc), (reply_to,))

        client = Client.instance
        self.assertEqual(client.fetched, [b'42'])
        self.assertEqual(len(client.searches), 1)
        self.assertIn('In-Reply-To', client.searches[0])
        self.assertIn('References', client.searches[0])
        self.assertEqual([reply.provider_message_id for reply in replies], ['<customer-reply@example.test>'])


if __name__ == '__main__':
    unittest.main()
