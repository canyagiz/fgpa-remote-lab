"""Run the shuttle provisioning playbook as a background job.

The setup wizard's endpoint hands off here. For one shuttle it: mints a
fresh token (so the admin never has to copy one), then runs
`provisioning/provision_shuttle.yml` against the machine in a worker
thread, capturing the output line by line so the wizard can poll for
progress.

Jobs live in memory. A provision interrupted by an app restart is simply
re-run, not resumed - which is fine, because the playbook is idempotent:
re-running it against a half-built shuttle finishes the job rather than
duplicating it.

Secrets - the SSH password and the freshly minted token - are written to
a mode-0600 extra-vars file for the duration of the run and deleted the
moment it ends. They never appear on a command line or in this process's
argv, where any other user on the box could read them from /proc.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import Shuttle
from app.security import generate_shuttle_token

# This file is <repo>/backend/app/services/provisioning.py, so the engine
# built in Phase 1 is three levels up, under provisioning/.
PROVISIONING_DIR = Path(__file__).resolve().parents[3] / "provisioning"
PLAYBOOK = "provision_shuttle.yml"

# Kept in sync with group_vars/all.yml::intel_boards - these are the
# families that need Quartus, so the check can fail fast here with a clear
# message instead of deep inside Ansible.
_INTEL_BOARDS = {"cx", "civ", "cv"}


class ProvisionError(Exception):
    """A provision could not even be started (bad input, no address)."""


@dataclass
class ProvisionJob:
    job_id: str
    shuttle_id: int
    status: str = "pending"  # pending | running | succeeded | failed
    returncode: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    _log: list[str] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def append(self, line: str) -> None:
        with self._lock:
            self._log.append(line.rstrip("\n"))

    def snapshot(self) -> list[str]:
        with self._lock:
            return list(self._log)


_JOBS: dict[str, ProvisionJob] = {}
_JOBS_LOCK = threading.Lock()


def get_job(job_id: str) -> ProvisionJob | None:
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def start_provision(db: Session, shuttle: Shuttle, req) -> ProvisionJob:
    """Validate, rotate the token, and launch the playbook in a thread."""
    ssh_host = (req.ssh_host or shuttle.address or "").strip()
    if not ssh_host:
        raise ProvisionError(
            "No address to reach this shuttle over SSH. Set the shuttle's "
            "address first, or pass ssh_host."
        )
    if any(b in _INTEL_BOARDS for b in req.boards) and not req.quartus_installer_path:
        raise ProvisionError(
            "Intel/Altera boards need a licensed Quartus installer already "
            "on the shuttle (bring-your-own). Provide quartus_installer_path, "
            "or select only the Arty board."
        )

    # Rotate: the wizard injects this fresh token straight into the agent,
    # so it is never shown to a human. Any token issued before now stops
    # working immediately - the same guarantee /rotate-token gives.
    token, token_hash = generate_shuttle_token(shuttle.id)
    shuttle.token_hash = token_hash
    db.commit()

    extra_vars = {
        "ansible_host": ssh_host,
        "ansible_user": req.ssh_user,
        "ansible_password": req.ssh_password,
        # Same password escalates with sudo when the SSH user is not root.
        "ansible_become_password": req.ssh_password,
        "agent_token": token,
        "shuttle_boards": list(req.boards),
        "device_map": dict(req.device_map),
        "board_uart": dict(req.board_uart),
        "quartus_installer_path": req.quartus_installer_path,
    }

    job = ProvisionJob(job_id=uuid.uuid4().hex, shuttle_id=shuttle.id)
    with _JOBS_LOCK:
        _JOBS[job.job_id] = job

    threading.Thread(
        target=_run, args=(job, ssh_host, extra_vars), daemon=True
    ).start()
    return job


def _run(job: ProvisionJob, ssh_host: str, extra_vars: dict) -> None:
    job.status = "running"
    job.started_at = datetime.utcnow()

    inv = tempfile.NamedTemporaryFile("w", suffix=".ini", delete=False)
    var = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    try:
        # 0600 before writing the secret into it.
        os.chmod(var.name, 0o600)
        inv.write(f"[shuttles]\n{ssh_host}\n")
        inv.flush()
        inv.close()
        json.dump(extra_vars, var)
        var.flush()
        var.close()

        cmd = ["ansible-playbook", "-i", inv.name, PLAYBOOK, "-e", f"@{var.name}"]
        # Deliberately does not echo the real paths' contents - only a
        # readable stand-in - so the log the wizard shows never leaks the
        # token or password.
        job.append(f"$ ansible-playbook -i <inventory> {PLAYBOOK} -e @<vars>")

        env = {
            **os.environ,
            "ANSIBLE_HOST_KEY_CHECKING": "False",
            "ANSIBLE_FORCE_COLOR": "0",
        }
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(PROVISIONING_DIR),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError:
            job.append(
                "ansible-playbook not found. Install it in the portal "
                "container:  apt-get install -y ansible sshpass"
            )
            job.status = "failed"
            job.returncode = 127
            return

        assert proc.stdout is not None
        for line in proc.stdout:
            job.append(line)
        proc.wait()
        job.returncode = proc.returncode
        job.status = "succeeded" if proc.returncode == 0 else "failed"
    except Exception as exc:  # noqa: BLE001 - surface any failure into the log
        job.append(f"provisioning crashed: {exc!r}")
        job.status = "failed"
        if job.returncode is None:
            job.returncode = 1
    finally:
        for path in (inv.name, var.name):
            try:
                os.unlink(path)
            except OSError:
                pass
        job.finished_at = datetime.utcnow()


# --- Quartus installer transfer (browser upload -> scp to the shuttle) --

def safe_installer_name(name: str) -> str:
    """A filename safe to drop in /root on the shuttle: basename only,
    exotic characters flattened, never empty."""
    base = os.path.basename((name or "").strip())
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return base or "installer.run"


def scp_installer(host: str, user: str, password: str, local_path: str, filename: str) -> str:
    """Copy a local file to /root/<name> on the shuttle over scp.

    The password goes through the SSHPASS env var, never the command line.
    Returns the remote path, which becomes quartus_installer_path.
    """
    remote = f"/root/{safe_installer_name(filename)}"
    cmd = [
        "sshpass", "-e", "scp",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        local_path, f"{user}@{host}:{remote}",
    ]
    env = {**os.environ, "SSHPASS": password}
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    except FileNotFoundError:
        raise ProvisionError(
            "sshpass is not installed in the portal container - "
            "apt-get install -y sshpass openssh-client"
        )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "scp failed").strip().splitlines()
        raise ProvisionError(
            "Could not copy the installer to the shuttle: "
            + (tail[-1] if tail else "scp failed")
        )
    return remote


# --- SSH connectivity check + hardware detection (wizard step 1 -> 2) ---

_SSH_OPTS = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
]

# Emitted over SSH and parsed line by line. Uses echo (no printf \\n) so it
# needs no escaping, and every probe tolerates the tool or path being
# absent - a fresh shuttle may not have the udev symlinks yet, in which
# case the raw presence (lsusb) is still reported.
_DETECT_SCRIPT = """
PVE=$(pveversion 2>/dev/null | head -1)
UB=$(lsusb 2>/dev/null | grep -iE '09fb:|Altera|USB-Blaster' | head -1)
UBL=$(ls /dev/usb-blaster 2>/dev/null)
MW=$(lsusb 2>/dev/null | grep -i magewell | head -1)
MWL=$(ls /dev/magewell 2>/dev/null)
echo "PVE=$PVE"
echo "UB=$UB"
echo "UBL=$UBL"
echo "MW=$MW"
echo "MWL=$MWL"
for v in $(ls /dev/v4l/by-id/ 2>/dev/null); do echo "VID=/dev/v4l/by-id/$v"; done
for v in $(ls /dev/video* 2>/dev/null); do echo "VDEV=$v"; done
for s in $(ls /dev/serial/by-id/ 2>/dev/null); do echo "SER=/dev/serial/by-id/$s"; done
"""


def _ssh(host, user, password, remote_cmd, timeout=40):
    cmd = ["sshpass", "-e", "ssh", *_SSH_OPTS, f"{user}@{host}", remote_cmd]
    env = {**os.environ, "SSHPASS": password}
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise ProvisionError(
            "sshpass is not installed in the portal container - "
            "apt-get install -y sshpass openssh-client"
        )
    except subprocess.TimeoutExpired:
        raise ProvisionError("Timed out reaching the shuttle over SSH.")
    return proc.returncode, proc.stdout, proc.stderr


def check_ssh(host, user, password):
    """Try to log in and read the machine\'s identity. Returns (ok, message)."""
    rc, out, err = _ssh(host, user, password, "pveversion 2>/dev/null | head -1 || uname -srm")
    if rc == 0:
        line = (out.strip() or "connected").splitlines()
        return True, (line[0] if line else "connected")
    msg = (err or out or "SSH connection failed").strip().splitlines()
    return False, (msg[-1] if msg else "SSH connection failed")


def detect_devices(host, user, password):
    """Scan the shuttle for the hardware the lab containers will bind."""
    rc, out, err = _ssh(host, user, password, _DETECT_SCRIPT)
    if rc != 0 and not out.strip():
        msg = (err or "device scan failed").strip().splitlines()
        raise ProvisionError(msg[-1] if msg else "Could not scan the shuttle")

    found = {"pve": "", "ub": "", "ubl": "", "mw": "", "mwl": "", "vid": [], "vdev": [], "ser": []}
    for line in out.splitlines():
        if line.startswith("PVE="):
            found["pve"] = line[4:]
        elif line.startswith("UBL="):
            found["ubl"] = line[4:]
        elif line.startswith("UB="):
            found["ub"] = line[3:]
        elif line.startswith("MWL="):
            found["mwl"] = line[4:]
        elif line.startswith("MW="):
            found["mw"] = line[3:]
        elif line.startswith("VID="):
            found["vid"].append(line[4:])
        elif line.startswith("VDEV="):
            found["vdev"].append(line[5:])
        elif line.startswith("SER="):
            found["ser"].append(line[4:])

    videos = found["vid"] or found["vdev"]
    return {
        "pve": found["pve"],
        "usb_blaster": {
            "present": bool(found["ub"]),
            "path": found["ubl"] or "/dev/usb-blaster",
            "info": found["ub"],
        },
        "capture": {
            "present": bool(found["mw"]),
            "path": found["mwl"] or "/dev/magewell",
            "info": found["mw"],
        },
        "videos": videos,
        "serial": found["ser"],
    }
