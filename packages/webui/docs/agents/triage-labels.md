# Triage labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the label
strings used in this repo's issue tracker.

| Role | Label | Meaning |
| --- | --- | --- |
| needs-triage | `needs-triage` | Maintainer needs to evaluate this issue |
| needs-info | `needs-info` | Waiting on the reporter for more information |
| ready-for-agent | `ready-for-agent` | Fully specified, ready for an agent to run unattended |
| ready-for-human | `ready-for-human` | Requires human implementation |
| wontfix | `wontfix` | Will not be actioned |

The label strings match the canonical role names one for one, so a skill may use either the role or
the label. When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the label
string from this table.

Issues are created, labelled and closed on the fork with `gh`; see
[`issue-tracker.md`](issue-tracker.md).
