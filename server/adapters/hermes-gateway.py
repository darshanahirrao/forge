"""Run the installed Hermes gateway; never invoke a service manager or replace a gateway."""
import hermes_bootstrap

hermes_bootstrap.harden_import_path()

import asyncio
import json
import os
from pathlib import Path
import sys

bootstrap = json.loads(sys.stdin.read(16385))
if not isinstance(bootstrap, dict) or set(bootstrap) != {"home"}:
    raise RuntimeError("Invalid native gateway bootstrap")
home = Path(bootstrap["home"]).resolve(strict=True)
if str(home) != os.environ.get("HERMES_HOME"):
    raise RuntimeError("Native gateway profile changed")
from hermes_cli import __version__

if __version__ != "0.17.0":
    raise RuntimeError("Unsupported native Hermes gateway contract")

# The native module loads its profile, secret sources and policy. Preserve those
# semantics, including its configured native interfaces and authentication.
from gateway.run import start_gateway
from gateway.config import load_gateway_config
from hermes_constants import get_hermes_home

if get_hermes_home().resolve(strict=True) != home:
    raise RuntimeError("Native gateway effective profile changed")
config = load_gateway_config()
if getattr(config, "multiplex_profiles", False):
    raise RuntimeError("A Forge-owned gateway must use one explicit native profile")
bootstrap = None

# start_gateway owns native channels, agents, cron, memory and graceful teardown.
# replace=False retains its native duplicate-instance/profile-lock guard.
success = asyncio.run(start_gateway(config=config, replace=False, verbosity=None))
for stream in (sys.stdout, sys.stderr):
    try:
        stream.flush()
    except Exception:
        pass
os._exit(0 if success else 1)
