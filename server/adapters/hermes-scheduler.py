"""Read installed native ticker evidence only. Never tick, resolve plugins or mutate jobs."""
import contextlib
import io
import json
import math
import os
import stat
import time

def sample():
    # Reuse native configuration parsing and public native marker readers. Import
    # chatter is not part of Forge's private, bounded observation contract.
    from hermes_cli.config import cfg_get, read_raw_config
    from cron.jobs import (get_ticker_heartbeat_age, get_ticker_success_age,
                           TICKER_INTERVAL_SECONDS, TICKER_HEARTBEAT_FILE, TICKER_SUCCESS_FILE)

    config = read_raw_config()
    provider = cfg_get(config, "cron", "provider", default="")
    if not isinstance(provider, str):
        raise ValueError("Unsupported native provider configuration")
    provider = provider.strip() or "builtin"
    result = {"contract": 1, "provider": provider, "loopAgeSeconds": None,
              "successAgeSeconds": None, "cadenceSeconds": TICKER_INTERVAL_SECONDS,
              "sampledAt": time.time()}
    if provider in ("builtin", "in-process", "inprocess"):
        def age(reader, path):
            # Native readers clamp future/NaN epochs to zero. Validate their
            # small marker first so invalid clocks cannot appear freshly healthy.
            try:
                fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
                with os.fdopen(fd, "rb") as marker:
                    info = os.fstat(marker.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > 128:
                        return None
                    raw = marker.read(129)
                epoch = float(raw)
                if len(raw) > 128 or not math.isfinite(epoch) or epoch <= 0 or epoch > time.time() + 2:
                    return None
                value = reader()
                return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None
            except Exception:
                return None
        result["loopAgeSeconds"] = age(get_ticker_heartbeat_age, TICKER_HEARTBEAT_FILE)
        result["successAgeSeconds"] = age(get_ticker_success_age, TICKER_SUCCESS_FILE)
    return result

try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = sample()
except Exception:
    result = {"contract": 1, "provider": None, "loopAgeSeconds": None,
              "successAgeSeconds": None, "cadenceSeconds": None, "sampledAt": time.time()}
print(json.dumps(result, allow_nan=False))
