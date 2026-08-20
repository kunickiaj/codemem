# Device Identity Setup Workflow Simplification

**Date:** 2026-08-19

**Status:** Approved

## Problem

Device Identity setup currently asks for three overlapping confirmations: include the device in a batch, confirm the device-to-Identity assignment, and confirm the reviewed preview. It also places bulk and per-device review actions on the same screen without clearly stating their different scopes.

## Design

- Keep one per-card checkbox, labeled **Select for setup**, for building a bulk setup batch.
- Keep the Identity dropdown as the assignment control.
- Remove the per-device **Confirm device belongs to Identity** checkbox.
- Require an Identity for every device included in a review.
- Keep **Review N selected** as the bulk action.
- Rename the card action to **Review this device**; it reviews only that card regardless of other selections.
- Keep the final preview confirmation as the single explicit approval step.
- Label the final action **Apply setup to N device(s)** using the exact reviewed count.

Suggested Identities remain non-authoritative. They may be displayed in the dropdown, but no binding is written until the user reviews the server-generated preview and completes the final confirmation.

## Behavioral Guarantees

- Bulk review previews and applies exactly the selected devices.
- Per-device review previews and applies exactly that device.
- Commit uses the preserved reviewed request rather than current selection state.
- Changing selection or Identity choice invalidates an existing preview.
- Pairing-required and conflicted devices remain outside normal Identity setup.

## Testing

- Verify the setup card has one checkbox rather than two.
- Verify Identity selection is sufficient to make a selected device reviewable.
- Verify bulk review sends all selected devices.
- Verify per-device review and commit remain scoped to one device.
- Verify the final action contains the reviewed device count.
