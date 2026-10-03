This maintenance patch backports the direct-peer sync and peer-memory cleanup fixes from #1922 onto 0.46.2. It does not include the unfinished 0.47 changes.

## Highlights

- **Reliable direct-peer requests:** Recipient-bound sync reads and writes close their HTTP connections after each response. This prevents a later write from reusing a peer socket that expired while synchronous sync preparation blocked the sender. Coordinator and administrator requests are unchanged; failed writes are not retried automatically.
- **Faster peer-memory cleanup:** Authorization is resolved once per scope within each cleanup transaction instead of once per memory. Every new transaction reloads authorization, so later membership or revocation changes remain visible. A 50,000-row, two-scope synthetic case fell from 1,822 ms and 50,000 authorization queries to 19 ms and two queries with the same retained rows.

## Compatibility and upgrade

Install the matching 0.46.3 packages, then restart the viewer and sync services on both peers when safe. An already-running service continues using its previous code until restarted. Verify a sync initiated from the previously affected peer after both services restart. This patch does not address separate peer address-cache churn.
