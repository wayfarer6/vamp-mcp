# Show HN: VAMP – Run AI computer-use agents in VMs on your own hardware

VAMP gives computer-use agents a guest desktop on hardware you control. You can keep using your own keyboard and mouse while the agent interacts with a Windows or Debian VM. A supported remote Linux KVM host can also provide the guest desktop over SSH.

For a recurring task, you can save a reviewed automation and replay it locally. The replay can check screenshots and output files on the host, so it does not need to send frames to a model during successful deterministic execution. Exploration and targeted recovery can involve an external model if its client requests screen data. Vault can deliver approved secrets through the configured guest connection without putting their values in the prompt.

The [installation demos](../README.md#how-to-use) show the VM setup paths. The split-screen shot list below covers the separate replay demo.

## 60-second split-screen shot list

| Time | Host view | Guest view and evidence |
| --- | --- | --- |
| 00–10 s | Show the editor and a separate guest viewer. | Show the starting screen of a reviewed, fixture-backed workflow. |
| 10–35 s | Continue typing in the editor while the saved RPA runs. | Show the expected guest actions and the generated output. |
| 35–50 s | Keep the editor in focus. | Show the Robot result and verify the output independently. |
| 50–60 s | Show model-call telemetry for the recorded replay. | State the measured result only if the telemetry covers the full run. |

Use synthetic data, reset the fixture before each take, and keep the host pointer visible in the split-screen recording.
