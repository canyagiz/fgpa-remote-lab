# Shuttle provisioning engine

The command-line engine behind the fleet **setup wizard**. Given a fresh
machine that already runs Proxmox VE and is reachable over SSH, it turns
that machine into a working *shuttle* — a node that runs the lab
containers for its attached boards and an agent that reports them to the
central portal — **without any golden image**. Everything is pulled at
run time from GitHub, Docker's own channels, and (for Intel boards only)
an operator-supplied Quartus installer.

This is Phase 1 of the wizard: the automation, driven from a terminal.
The portal endpoint (Phase 2) and the browser wizard UI (Phase 3) call
this same playbook; getting it right here is what makes those thin.

## The shape of what it builds

```
     you / the portal
            │  ssh (root/password on first contact, then a key)
            ▼
   ┌──────────────────────────  shuttle (Proxmox VE host)  ──────────────┐
   │                                                                     │
   │   LXC: lab (docker)                      LXC: agent                 │
   │   ├─ Docker Engine (get.docker.com)      ├─ git clone agent repo    │
   │   ├─ git clone hardware repo             ├─ /etc/fpga-lab-agent/    │
   │   ├─ build|pull board images            │     agent.conf + agent.env│
   │   ├─ Quartus (Intel boards, BYO)         └─ systemd: fpga-lab-agent  │
   │   └─ docker compose up <this shuttle's boards>          │           │
   └────────────────────────────────────────────────────────┼───────────┘
                                                             │ phone-home
                                                             ▼
                                               central portal  /inventory/report
```

Nothing here is copied from the master. A new adopter of the open-source
project runs the same engine against their own machine and pulls the same
public sources — there is no 10 GB blob anyone has to host.

## Why no golden image

- A monolithic snapshot has to live *somewhere* we host, which makes us a
  single point of failure and is poor open-source hygiene. `git`, `apt`
  and `docker pull` come from CDNs, resume on failure, and are
  independently verifiable.
- The only thing that genuinely resists this is **Quartus** — Intel/Altera
  gate the download behind an account and EULA, so it cannot be fetched by
  script. That one artifact is **bring-your-own-license**: the operator
  places their licensed installer on the shuttle and points
  `quartus_installer_path` at it. Arty (Xilinx) needs none of this — its
  toolchain (openFPGALoader + openocd) is open source and baked into the
  `fpga-lab-z7` image from the hardware repo's `Dockerfile.z7`.

## Prerequisites (the one manual, physical step)

The shuttle must already have **Proxmox VE installed and SSH reachable**.
Installing the hypervisor itself is an ISO/boot-time job, not something
done idempotently over SSH — so it stays outside the wizard. Everything
above that line is automated here.

## Usage

```bash
cd provisioning
# 1. describe the shuttle: copy the example and fill in its hardware
cp inventory/host_vars/shuttle13.yml.example inventory/host_vars/shuttle13.yml
$EDITOR inventory/host_vars/shuttle13.yml

# 2. run it (the token is injected, never stored in a file you commit)
ansible-playbook -i inventory/hosts.ini provision_shuttle.yml \
  -l shuttle13 \
  -e "agent_token=frl_13_xxxxxxxx" \
  --ask-pass                      # SSH password entered in the wizard
```

The portal calls this the same way, passing `agent_token` from a freshly
rotated token and the SSH credentials from the wizard form. It never has
to show the token to a human.

## The one part that is not cookie-cutter

Which USB device is which board depends on physical cabling, so the
per-shuttle device map (`device_map`, `board_uart` in host_vars) cannot be
guessed — it is what the wizard's **"detected devices"** step produces.
Prefer the stable udev symlinks (see `udev/` in the hardware repo) over
raw `/dev/bus/usb/...` paths, which renumber on replug.

## Files

| Path | What it is |
|------|------------|
| `provision_shuttle.yml` | the play: preflight → lab LXC → agent LXC → verify |
| `group_vars/all.yml` | fleet-wide defaults (repos, portal URL, LXC sizing) |
| `inventory/host_vars/*.yml` | one file per shuttle: connection + hardware map |
| `templates/lab.env.j2` | renders the hardware repo's `.env` from the device map |
| `templates/configure-lab.sh.j2` | runs *inside* the lab LXC: docker, clone, build, up |
| `templates/agent.conf.j2` / `agent.env.j2` | agent config; token kept out of world-readable files |
| `templates/configure-agent.sh.j2` | runs *inside* the agent LXC: clone, install, enable |

No Ansible Galaxy collections are required — the play drives Proxmox
through the `pct` CLI over the SSH connection, exactly as an admin would.
