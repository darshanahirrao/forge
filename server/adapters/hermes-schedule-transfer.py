"""Construct through native create_job in an inert profile; publish through native save_jobs.

Never create an enabled job in a live destination, invoke a ticker or resolve a plugin.
The native 0.17.0 reentrant flock and atomic writer remain authoritative.
"""
import contextlib
import hashlib
import io
import json
import os
import stat
import sys
import time

attempted = False

def read(path):
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 * 1024 or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise ValueError()
        raw = handle.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError()
        return raw

def sha(raw):
    return hashlib.sha256(raw if raw is not None else b"missing").hexdigest()

def operation(request):
    global attempted
    import cron.jobs as jobs
    from hermes_cli import config
    import hermes_time
    from hermes_cli import __version__
    if __version__ != "0.17.0" or jobs.fcntl is None:
        raise ValueError()
    home = os.path.realpath(os.environ["HERMES_HOME"])
    if str(jobs.JOBS_FILE) != os.path.join(home, "cron", "jobs.json") or str(config.get_config_path()) != os.path.join(home, "config.yaml"):
        raise ValueError()
    mode = request["mode"]
    cron_dir = os.path.join(home, "cron")
    if os.path.lexists(cron_dir):
        info = os.lstat(cron_dir)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError()
    if mode == "construct":
        p = request["portable"]
        s = p["schedule"]
        rule = s["at"] if s["kind"] == "at" else ("every %sm" % s["minutes"] if s["kind"] == "every" else s["expr"])
        job = jobs.create_job(prompt=p["prompt"], name=p["title"], schedule=rule, deliver="local")
        paused = jobs.pause_job(job["id"], reason="Staged by a reviewed Forge schedule transfer")
        if not paused or paused.get("enabled") is not False or paused.get("state") != "paused":
            raise ValueError()
        return {"definition": json.dumps(paused, allow_nan=False)}
    with jobs._jobs_lock():
        fd = os.open(jobs._jobs_lock_file(), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            try:
                jobs.fcntl.flock(fd, jobs.fcntl.LOCK_EX | jobs.fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                jobs.fcntl.flock(fd, jobs.fcntl.LOCK_UN)
                raise ValueError()
        finally:
            os.close(fd)
        with jobs._jobs_lock():
            raw = read(jobs.JOBS_FILE)
            config_raw = read(config.get_config_path())
            cfg = config.fast_safe_load(config_raw.decode()) if config_raw else {}
            if not isinstance(cfg, dict) or (config.cfg_get(cfg, "cron", "provider", default="") or "builtin") not in ("builtin", "in-process", "inprocess"):
                raise ValueError()
            data = json.loads(raw) if raw is not None else {"jobs": []}
            if not isinstance(data, dict) or not isinstance(data.get("jobs"), list) or len(data["jobs"]) >= 2000:
                raise ValueError()
            evidence = {"jobsDigest": sha(raw), "configDigest": sha(config_raw), "timezone": str(hermes_time.get_timezone() or "")}
            if mode == "inspect":
                return evidence
            if mode != "publish" or request["jobsDigest"] != evidence["jobsDigest"] or request["configDigest"] != evidence["configDigest"] or time.time() * 1000 > request["deadline"]:
                raise ValueError()
            job = json.loads(request["definition"])
            if job.get("enabled") is not False or job.get("state") != "paused" or any(row.get("id") == job["id"] for row in data["jobs"]):
                raise ValueError()
            # Template came from native construction in a private inert profile.
            # Publish its disabled record once, using the existing native writer.
            # Native inference-default drift guards must describe the destination,
            # rather than the inert template's deliberately unconfigured provider.
            provider_snapshot, model_snapshot = jobs._compute_provider_model_snapshots(
                provider=None, model=None, base_url=None, no_agent=False)
            job["provider_snapshot"] = provider_snapshot
            job["model_snapshot"] = model_snapshot
            attempted = True
            jobs.save_jobs([*data["jobs"], job])
            return {"jobId": job["id"]}

try:
    raw = sys.stdin.buffer.read(131073)
    if len(raw) > 131072:
        raise ValueError()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = operation(json.loads(raw))
except Exception:
    result = {"error": "uncertain" if attempted else "unavailable"}
print(json.dumps(result, allow_nan=False))
