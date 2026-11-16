"""Verify recorder distributions without importing host input libraries."""
import importlib.metadata as metadata
import json
print(json.dumps({name: metadata.version(name) for name in ('PyAutoGUI', 'pynput')}))
