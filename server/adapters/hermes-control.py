"""Fence an existing native pause/resume with the native cross-process lock."""
import contextlib
import hashlib
import io
import json
import os
import stat
import time

attempted = False

def read(path, limit=2 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
            raise ValueError()
        data = handle.read(limit + 1)
        if len(data) > limit:
            raise ValueError()
        return data

def digest(value):
    return hashlib.sha256(value).hexdigest()

def bounded_text(value, limit):
    if not isinstance(value, str) or len(value.encode("utf8")) > limit:
        raise ValueError()
    return value

def operation(request):
    global attempted
    import cron.jobs as jobs
    from hermes_cli import config
    # No resolver/plugins, job loader, ticker or execution is invoked during preview.
    if jobs.fcntl is None or not all(callable(getattr(jobs, key, None)) for key in ("_jobs_lock", "pause_job", "resume_job")):
        raise ValueError()
    home = os.path.realpath(os.environ["HERMES_HOME"])
    if str(jobs.JOBS_FILE) != os.path.join(home, "cron", "jobs.json") or str(config.get_config_path()) != os.path.join(home, "config.yaml"):
        raise ValueError()
    with jobs._jobs_lock():
        # An independent descriptor must be excluded. Native fallback to an
        # in-process-only lock is insufficient for a reviewed cross-process write.
        fd = os.open(jobs._jobs_lock_file(), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            held = False
            try:
                jobs.fcntl.flock(fd, jobs.fcntl.LOCK_EX | jobs.fcntl.LOCK_NB)
            except BlockingIOError:
                held = True
            else:
                jobs.fcntl.flock(fd, jobs.fcntl.LOCK_UN)
            if not held:
                raise ValueError()
        finally:
            os.close(fd)
        # Exercise the deployed reentrant contract before permitting a mutation.
        with jobs._jobs_lock():
            raw = read(jobs.JOBS_FILE)
            data = json.loads(raw)
            if not isinstance(data, dict) or not isinstance(data.get("jobs"), list) or len(data["jobs"]) > 2000:
                raise ValueError()
            matches = [job for job in data["jobs"] if isinstance(job, dict) and job.get("id") == request["jobId"]]
            if len(matches) > 1:
                raise ValueError()
            try:
                config_raw = read(config.get_config_path())
            except FileNotFoundError:
                config_raw = None
            cfg = config.fast_safe_load(config_raw.decode("utf8")) if config_raw else {}
            if cfg is None:
                cfg = {}
            if not isinstance(cfg, dict):
                raise ValueError()
            provider = config.cfg_get(cfg, "cron", "provider", default="") or "builtin"
            if provider not in ("builtin", "in-process", "inprocess"):
                return {"state": "rejected", "code": "unsupported"}
            hashes = {"jobsDigest": digest(raw), "configDigest": digest(config_raw) if config_raw is not None else None}
            if not matches:
                return {"state": "absent", "contract": "hermes-builtin-native-flock/1", **hashes} if request["mode"] == "preview" else {"state": "rejected", "code": "changed"}
            job = matches[0]
            if not isinstance(job.get("enabled", True), bool) or not isinstance(job.get("no_agent", False), bool):
                raise ValueError()
            bounded_text(job.get("state") or ("scheduled" if job.get("enabled", True) else "paused"), 80)
            next_run = job.get("next_run_at")
            if next_run is not None:
                bounded_text(next_run, 120)
            prompt = bounded_text(job.get("prompt") or "", 20000)
            script = bounded_text(job["script"], 2000) if job.get("script") else None
            rule = bounded_text(json.dumps(job.get("schedule"), ensure_ascii=False), 2000)
            definition = bounded_text(json.dumps(job, indent=2, ensure_ascii=False, allow_nan=False), 65536)
            def observed(current):
                next_run = current.get("next_run_at")
                return {"state": bounded_text(current.get("state") or ("scheduled" if current.get("enabled", True) else "paused"), 80),
                        "enabled": bool(current.get("enabled", True)), "nextRunAt": next_run if isinstance(next_run, str) else None,
                        "jobsDigest": digest(read(jobs.JOBS_FILE))}
            if request["mode"] == "preview":
                import hermes_time
                timezone = hermes_time.get_timezone()
                return {"state": "preview", "contract": "hermes-builtin-native-flock/1", **hashes,
                        "job": {"id": job["id"], "title": str(job.get("name") or job["id"])[:160],
                                **({"timezone": str(timezone)} if timezone is not None else {}),
                                "prompt": prompt, "script": script, "rule": rule, "definition": definition,
                                "noAgent": bool(job.get("no_agent", False)), **{key: value for key, value in observed(job).items() if key != "jobsDigest"}}}
            if request.get("jobsDigest") != hashes["jobsDigest"] or request.get("configDigest") != hashes["configDigest"] or time.time() * 1000 > request.get("deadline", 0):
                return {"state": "rejected", "code": "changed"}
            desired = request["action"] == "resume"
            if bool(job.get("enabled", True)) == desired and ((desired and job.get("state") == "scheduled") or (not desired and job.get("state") == "paused")):
                return {"state": "applied", "observed": observed(job)}
            attempted = True
            updated = jobs.resume_job(job["id"]) if desired else jobs.pause_job(job["id"], reason="Paused through a reviewed Forge native control")
            if not updated or updated.get("id") != job["id"] or bool(updated.get("enabled", True)) != desired:
                raise ValueError()
            return {"state": "applied", "observed": observed(updated)}

try:
    raw_request = __import__("sys").stdin.buffer.read(8193)
    if len(raw_request) > 8192:
        raise ValueError()
    request = json.loads(raw_request)
    if request.get("mode") not in ("preview", "apply") or request.get("action") not in ("pause", "resume"):
        raise ValueError()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = operation(request)
except Exception:
    result = {"state": "uncertain" if attempted else "rejected", "code": "unavailable"}
print(json.dumps(result, ensure_ascii=False, allow_nan=False))
