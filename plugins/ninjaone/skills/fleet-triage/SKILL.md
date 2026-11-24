---
name: fleet-triage
description: Daily NinjaOne fleet triage across every client - offline devices, unhealthy devices, open alerts, failed patches and antivirus threats, ranked by what needs attention first. Use when the user asks what needs attention, for a morning check, a health summary, or "how are my clients doing".
---

# Fleet triage

Goal: a short, ranked list of what needs a technician today. Each item gets the evidence behind it and the next action.

## Steps

1. Call `ninjaone_report_fleet_health`. It reads every organization in scope. Note failed rows and say which clients could not be read.
2. Rank organizations by offline servers first, then failed patches, AV threats, active alerts and the share of devices offline.
3. For the top three organizations, drill in:
   - `ninjaone_list_devices` with `df: "org = <id> AND offline"` and `fields: ["id","systemName","nodeClass","lastContact"]` gives what is down and since when.
   - `ninjaone_list_alerts` with `df: "org = <id>"` gives what is alerting.
   - `ninjaone_report_antivirus_threats` with the same `df`, if threats are above zero.
4. Servers matter more than workstations. A device offline for more than 24 hours is likely down, not asleep.
5. For any single device the user picks, use `ninjaone_get_device_profile`.

## Output

- A one-line headline: clients, devices, how many need attention.
- A table: Client, Issue, Devices, Since, Suggested action.
- A "could not check" line for failed organizations or capped reports.

Do not reboot, reset alerts or run scripts during triage. Offer them as next steps, and take each only on the user's explicit go-ahead.
