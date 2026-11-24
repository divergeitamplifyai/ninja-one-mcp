---
name: patch-review
description: Review NinjaOne patch status - pending, failed and rejected OS and third-party patches by client and device, install history, and what to do about failures. Use for patch compliance, Patch Tuesday readiness, "which machines are missing updates" or a failed patch investigation.
---

# Patch review

## Steps

1. Scope it. For one client, resolve it with `ninjaone_find_organization` and use `df: "org = <id>"`. Use no df for the whole estate.
2. Get the open patches:
   - `ninjaone_report_os_patches` with `status: "FAILED"`, then again with `status: "PENDING"`.
   - `ninjaone_report_software_patches` for third-party applications.
   - Follow `next_cursor` until `has_more` is false, or say the numbers are partial.
3. Group the failures by patch (KB or product) and by device. A patch failing on many devices points to the patch. Many patches failing on one device point to the device: check disk space with `ninjaone_list_device_volumes` and reboot state with `ninjaone_get_device_profile`.
4. For history, use `ninjaone_report_os_patch_installs` with `installed_after`.

## Output

- Totals: failed, pending and rejected, OS and third-party.
- The top failing patches with device counts.
- The devices with the most failures, with likely causes.
- Recommended actions.

## Acting on it

- `ninjaone_run_os_patch_scan` (write) refreshes the status of one device.
- `ninjaone_apply_os_patches` is destructive. It installs patches now and may reboot the device by policy.
- State the device, the patches and the reboot risk. Get an explicit go-ahead before applying, one device at a time.
