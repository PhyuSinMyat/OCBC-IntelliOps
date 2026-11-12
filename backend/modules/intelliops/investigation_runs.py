"""Bounded process-local retry deduplication. No database or financial persistence."""
from copy import deepcopy
from threading import Event, Lock
from time import monotonic
from .service import CaseError

_lock = Lock()
_runs = {}
TTL_SECONDS = 300
MAX_RUNS = 64


def once(key, execute):
    with _lock:
        now = monotonic()
        for old_key in list(_runs):
            if _runs[old_key]['done'].is_set() and _runs[old_key]['expires'] <= now:
                del _runs[old_key]
        entry = _runs.get(key)
        owner = entry is None
        if owner:
            if len(_runs) >= MAX_RUNS:
                raise CaseError('Investigation request cache is full. Retry later without changing the request ID.', 429)
            entry = dict(done=Event(), result=None, expires=float('inf'))
            _runs[key] = entry
    if owner:
        try:
            entry['result'] = execute()
        except Exception:
            # Unknown failures are ambiguous; the same request ID must not spend again.
            entry['result'] = (503, {'detail': 'Investigation outcome is unavailable. Review before starting another paid request.'})
            raise
        finally:
            with _lock:
                entry['expires'] = monotonic() + TTL_SECONDS
                entry['done'].set()
    elif not entry['done'].wait(150):
        raise CaseError('Investigation is still running. Retry with the same request ID.', 409)
    return deepcopy(entry['result'])
