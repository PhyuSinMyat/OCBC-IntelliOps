"""Opt-in process for overdue missing-ledger checks."""
import argparse
import logging
from time import sleep

import models  # Register the domain models.
from modules.intelliops.automatic_detection import enabled
from modules.intelliops.overdue_detection import scan_overdue
from shared.database import engine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watch", action="store_true", help="Repeat checks every 20 seconds.")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    if not enabled():
        parser.error("automatic detection is disabled")
    while True:
        try:
            created = scan_overdue(engine)
            if created:
                logging.info("Overdue detection created %s case(s).", len(created))
        except Exception:
            if not args.watch:
                return 1
        if not args.watch:
            return 0
        sleep(20)


if __name__ == "__main__":
    raise SystemExit(main())
