#!/bin/sh
cat <<'TXT'
DEPLOY (spec 12.2) - tick each manually
 1 Console open, correct account, billing mode checked
 2 Image placeholder replaced with pinned digest
 3 SDL validated; resources + bid denom checked
 4 Provider quote reviewed; cost approved
 5 Deployment created; service ready
 6 Service URI copied; /health OK; event delivery confirmed
 7 Access restriction applied; one controlled request run
 8 Deployment ID + URI recorded
CLEANUP (spec 12.3)
 1 Stop runner   2 Export permitted records   3 Revoke producer token
 4 Close lease   5 Confirm closed in Console 6 Check deposit/billing
 7 Delete synthetic data per retention policy
TXT
