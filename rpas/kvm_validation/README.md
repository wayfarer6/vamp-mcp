# kvm_validation

Manual RPA template for `debian`.

- `run.robot`: sequence, branching and assertions.
- `workflow.py`: Python SPICE/coordinate/vision behavior.
- `manifest.json`: package metadata.
- The default task returns `not_configured` and SKIPs without a VM connection.
- Launch programs through Alt+F2, not user-specific desktop icons.
- Implement positive verification before reporting `succeeded`.
- See [manual/conversion guide](../../docs/RECORDING_CONVERSION.md).
